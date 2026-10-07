/**
 * Forward-only schema migrations (ADR-0014 §4). Never edit an applied migration; add a new one.
 * The schema itself follows ADR-0002 (effects, lease), ADR-0003 (checkpoints = commits),
 * ADR-0005 (artifact versions, approvals), ADR-0006 (actor), ADR-0018 (events, usage_window).
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  task              TEXT NOT NULL,
  workflow          TEXT NOT NULL,
  state             TEXT NOT NULL,
  state_reason      TEXT,
  owner_json        TEXT NOT NULL,
  workspace_json    TEXT NOT NULL,
  current_step      TEXT,
  current_iteration INTEGER NOT NULL DEFAULT 1,
  iterations_json   TEXT NOT NULL DEFAULT '{}',
  data_class        TEXT NOT NULL,
  profile           TEXT,
  lock_owner        TEXT,
  lock_epoch        INTEGER NOT NULL DEFAULT 0,
  lock_until        TEXT,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX runs_state ON runs(state);
CREATE INDEX runs_task ON runs(task);

CREATE TABLE step_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  step_id      TEXT NOT NULL,
  iteration    INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT,
  outcome      TEXT,
  inputs_json  TEXT NOT NULL DEFAULT '[]',
  outputs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX step_history_run ON step_history(run_id, id);

CREATE TABLE checkpoints (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  step_id     TEXT NOT NULL,
  iteration   INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  head_commit TEXT,
  state_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX checkpoints_run ON checkpoints(run_id, created_at);

CREATE TABLE blobs (
  content_ref TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  media_type  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE artifacts (
  artifact_id      TEXT NOT NULL,
  version          INTEGER NOT NULL,
  run_id           TEXT NOT NULL REFERENCES runs(id),
  type             TEXT NOT NULL,
  name             TEXT NOT NULL,
  schema_version   INTEGER NOT NULL DEFAULT 1,
  content_ref      TEXT NOT NULL REFERENCES blobs(content_ref),
  parent_version   INTEGER,
  provenance_json  TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  step_id          TEXT,
  iteration        INTEGER,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
CREATE INDEX artifacts_run ON artifacts(run_id, type);

CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  step_id     TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  content_ref TEXT NOT NULL,
  actor_json  TEXT NOT NULL,
  decision    TEXT NOT NULL,
  comment     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX approvals_artifact ON approvals(artifact_id, version);

CREATE TABLE effects (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  step_id     TEXT NOT NULL,
  iteration   INTEGER NOT NULL,
  key         TEXT NOT NULL UNIQUE,
  capability  TEXT NOT NULL,
  args_ref    TEXT,
  lease_epoch INTEGER NOT NULL,
  status      TEXT NOT NULL,
  result_ref  TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX effects_run ON effects(run_id, created_at);

CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  run_id       TEXT,
  step_id      TEXT,
  iteration    INTEGER,
  actor        TEXT,
  kind         TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX events_run ON events(run_id, seq);
CREATE INDEX events_kind ON events(kind, seq);

CREATE TABLE usage_window (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pool          TEXT NOT NULL,
  ts            TEXT NOT NULL,
  model         TEXT NOT NULL,
  run_id        TEXT,
  prompt_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL
);
CREATE INDEX usage_window_pool_ts ON usage_window(pool, ts);
`,
  },
  {
    version: 2,
    name: "interactions",
    sql: `
-- ADR-0019 §2: one entity for every human interaction; approvals keep their content binding.
CREATE TABLE interactions (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(id),
  kind           TEXT NOT NULL,
  step_id        TEXT NOT NULL,
  iteration      INTEGER NOT NULL,
  content_ref    TEXT,
  state          TEXT NOT NULL,
  origin         TEXT,
  opened_by      TEXT NOT NULL,
  opened_at      TEXT NOT NULL,
  resolved_by    TEXT,
  resolved_at    TEXT,
  resolution_ref TEXT,
  meta_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX interactions_run ON interactions(run_id, state);

CREATE TABLE interaction_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  seq            INTEGER NOT NULL,
  role           TEXT NOT NULL,
  actor          TEXT NOT NULL,
  text           TEXT NOT NULL,
  proposal_json  TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX interaction_messages_thread ON interaction_messages(interaction_id, seq);

ALTER TABLE runs ADD COLUMN waiting_for_json TEXT;
ALTER TABLE approvals ADD COLUMN outcome TEXT;
`,
  },
  {
    version: 3,
    name: "project_graph",
    sql: `
-- ADR-0008 §1: tree-level snapshots of the project graph; file facts live in the blob cache.
CREATE TABLE graph_snapshots (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL,
  tree_sha      TEXT NOT NULL,
  branch        TEXT,
  extractors    TEXT NOT NULL,
  files         INTEGER NOT NULL,
  cache_hits    INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX graph_snapshots_repo ON graph_snapshots(repo_id, created_at);

CREATE TABLE graph_nodes (
  snapshot_id   TEXT NOT NULL REFERENCES graph_snapshots(id),
  id            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  file          TEXT,
  metadata_json TEXT,
  PRIMARY KEY (snapshot_id, id)
);

CREATE TABLE graph_edges (
  snapshot_id   TEXT NOT NULL REFERENCES graph_snapshots(id),
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  relation      TEXT NOT NULL
);
CREATE INDEX graph_edges_from ON graph_edges(snapshot_id, from_id);
CREATE INDEX graph_edges_to ON graph_edges(snapshot_id, to_id);
`,
  },
  {
    version: 4,
    name: "retrieval",
    sql: `
-- ADR-0015 §2 v0.1: FTS5 over knowledge, standards, skills and artifacts; §4: vectors by unit identity.
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  source_id UNINDEXED,
  source_version UNINDEXED,
  kind UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE knowledge_units (
  source_id      TEXT PRIMARY KEY,
  source_version TEXT NOT NULL,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  ref            TEXT NOT NULL,
  indexed_at     TEXT NOT NULL
);
CREATE TABLE knowledge_vectors (
  source_id      TEXT NOT NULL,
  source_version TEXT NOT NULL,
  embedder       TEXT NOT NULL,
  dims           INTEGER NOT NULL,
  vector_json    TEXT NOT NULL,
  PRIMARY KEY (source_id, embedder)
);
`,
  },
  {
    version: 5,
    name: "run_options",
    sql: `
-- What the task asked of the run beyond its text: e.g. read the design frames again, past the cache.
ALTER TABLE runs ADD COLUMN options_json TEXT;
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
