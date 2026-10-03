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
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
