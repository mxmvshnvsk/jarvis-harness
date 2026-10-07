# Журнал реализации по этапам

Как строился Jarvis: этапы дорожной карты [ADR-0001](../adr/0001-target-architecture.md) §20 в порядке их выполнения, с тем, что появилось на
каждом. Это исторический журнал; актуальное описание возможностей — в [`docs/`](../README.md).

Коммиты по этапам (нумерация журнала; этапы 8 и 12 дорожной карты ADR-0001 §20 — первые два блока ниже): `94748d5` (ADR-0019…0021), `723f3c5` (6), `6887cf0` (8), `8db955b` (9+10),
`0dd2b8f` (11, часть), `474d113` (13 ф.1), `031c092` (quickstart), `ee23341` (12), `9f72b44` (13 ф.2),
`2e8e6ed` (14), `10fa9f5` (retrieval), `3dbee63` (review lifecycle), `bfa3ce3` (polyglot + run-to-case),
`5aa5810` (Windows DPAPI, watch, gc).

Remaining commands of ADR-0001 §15:

- `jarvis research <task>` and `jarvis spec <task>` — built-in workflows `research` (discover → research) and `spec`
  (research → requirements → specification → approval)
- `jarvis explain <file[:line]|commit|run>` — blame → commit → `Jarvis-Run` trailer → run → steps, artifacts with
  sources and approvals, clarifications, tool-call counts; `jarvis apply --message` now keeps the trailer

- `jarvis onboard` (quick mode) — deterministic repository scan without a model: module/graph facts, docs, tests and
  commit style, suggested `tools.local`, `architecture.md`/`conventions.md` skeletons with a regeneration marker
  (`src/onboarding/*`, `src/cli/commands/onboard.ts`, `tests/cli/onboard.test.ts`)
- `jarvis onboard --module <path>` (agent mode, prototype for one module) — `onboard-mapper` agent and `onboard-module`
  workflow; claims carry file + verbatim excerpt evidence that `src/onboarding/verify.ts` checks mechanically;
  what survives becomes a knowledge `candidate` with `paths`, promoted by a human. Not yet: fan-out over all modules,
  an LLM verification pass, `--refresh` by module hash, an eval of sdd runs with and without the generated knowledge

- `jarvis ask <question>` — knowledge base as a reference desk: glossary terms without a model (optional `определение`
  column), answers by the read-only `knowledge-answerer` agent (workflow `ask`) from knowledge docs, standards and
  skills only; citations are verified against the source text, an unconfirmed answer is not shown, `--general` adds
  a separately labelled model note (`src/knowledge/ask.ts`, `src/cli/commands/ask.ts`, `tests/cli/ask.test.ts`)

- Technical log (`src/telemetry/log.ts`, `src/cli/commands/logs.ts`, `src/cli/cliLog.ts`): NDJSON in `~/.jarvis/logs`, levels
  `JARVIS_LOG=off|error|info|debug`, mirror of the event journal, model request/response and tool bodies at debug (prompts as
  deltas), redaction, retention; `step.error` with stack, provider message in `model.error`, `args` in `tool.call`;
  `jarvis logs` and a `doctor` line. The `JARVIS_LOG*` variables are reserved (they used to be read as configuration paths)

- Pilot fixes, first real model (DeepSeek-V4-Flash behind a corporate gateway): a network error names the root of the
  `cause` chain with a hint for an untrusted CA / DNS / refused connection (`src/core/errorCause.ts`), the technical log
  writes the whole chain; `models probe` fails on an unreachable model instead of saving "supports nothing", gives every
  canary 512 output tokens for a reasoning model, and reports a cut-off answer as inconclusive, not as drift
- onboard --module: the evidence check finds symbols that start or end with punctuation (`@repo/shared`,
  `./eslint-config/*`); `\b` never matched them inside quotes
- agent finalization: when the tool loop ends with an answer that already is a valid result document (fenced or bare
  JSON), that is the result; otherwise the answer stays in the finalization request with its schema issues. The pilot
  paid two extra slow calls per step, and the re-asked model echoed the JSON Schema instead of filling it
- redaction: a repository path made of words (`packages/shared/eslint-config/base`) is not a high-entropy secret;
  the technical log no longer hides the paths in tool arguments
- `onboard --module` takes a directory inside a module (a large monorepo package is too much for one pass):
  facts are counted for that directory, dependencies named at its depth inside the package and by module outside
- `knowledge.sources` (`src/knowledge/sources.ts`): the team's documentation and `AGENTS.md` read in place — knowledge
  named by path, `SKILL_*`-style documents as skills, `scopes` from documentation to code paths, module memos scoped
  to their directory, denied paths skipped; `onboard --module` gives its run a `scope` artifact so the mapper gets the
  documentation of its module only; `knowledge.read` takes a bare document name
- agent context: the L3/L4 character budget comes from the window capped by `context.maxContext`, not the model's raw
  window (a 1M-token model with `maxContext: 200000` got a knowledge share sized for 1M)
- live progress (`src/app/activity.ts`, `src/cli/progress.ts`): the activity of a run from its events — step and
  agent, model calls and the current wait (slow vs past the timeout), tool budget bar, tokens, last tool — drawn on
  stderr by `work`/`resume`/`onboard --module`/`ask` and shown as `now` by `status`; `JARVIS_PROGRESS=off`
- provider trouble on screen: `model.retry`/`model.error` carry `attemptMs` and `maxRetries`; foreground commands
  print every retry (reason, attempt time, `traceId`), the final failure and a failed or parked run as lines that
  stay on stderr; the progress line counts the wait across retries; Ctrl-C releases the lease and says how to go on
- monorepo graph: `ProjectGraphExtractor.createResolver` (tree-level, part of the snapshot key); the TS resolver
  (`src/adapters/typescript/resolver.ts`) follows the nearest tsconfig's `paths`/`baseUrl` and maps workspace
  packages through `exports` back to their sources; onboarding names external packages `pkg:<name>` instead of
  "(root)". On the pilot repo: `#/…` and `@acme/shared-lib/…` resolve, a change in the shared
  library reaches the app files that import it
- resolver: before impact analysis a path scope is "unsure", not a match — path-scoped skills and documents rank after
  everything that certainly applies, so the documentation's skills no longer displace `sdd-implementation`
- standards: `mustNot` judges the lines a change adds (`lines: added`, the default; `all` for every line of a changed
  file) — rules for new code in a legacy codebase no longer send the implementation back over old lines
- onboarding: a kept claim that generalises beyond its excerpts ("every…", "the only…", "no…", "каждый/только…") is
  marked in the candidate and listed by `onboard --module` for review first — the excerpt check proves a quote exists,
  not that it supports "every" (pilot: "every handler catch reports its error the same way" passed; most handler files did not)
- candidates: human names instead of artifact ids (`shared-lib/billing`, `server/plugins`, `…@<run>` for an
  older candidate about the same thing; any unique part works), `candidates show` prints the document as promote
  would write it with the generalisations to check, `list` says where to look (code paths, most quoted files) and how
  many claims to check; module maps are promoted to `module-<name>.md` without `--id`
- module research from `jarvis ui` (Knowledge → Modules): the module tree of the scan down to folders, with size and
  coverage (own document, generated, a wider one, the team's documentation via `scopes`, may be stale); a folder over
  150 files / 15k lines is offered in parts; `jarvis onboard --module` started in the background, one at a time with a
  queue; the claim check is now the `verify` step of `onboard-module` (a run resumed later still ends with its
  candidate), the candidate keeps the dropped claims and the note (`--note`); the review: confirmed / dropped / to
  check (every generalisation ticked before Accept), Replace with a diff for a document a person wrote
  (`candidates promote --replace`; a generated one is replaced), Research again with a note, Commit knowledge
- Knowledge pages in `jarvis ui`: Overview ("would an agent find it?" with the glossary's expansions, documents,
  may be stale, folders to research first), Documents/Architecture, Standards (with what the check found in recent
  runs), Skills (overrides, did it reach the agent), Glossary (problems: a symbol not in the code, a synonym of two
  terms; add a term after a check of its symbols against the code); use in runs from `agent.start` provenance and
  `knowledge.read`; a wide document no longer counts as a folder's coverage
- quota admission reserves the typical answer of the same kind of call (p95 of the agent's recent answers, turns
  and final answers apart, 2k..maxOutput) instead of the whole maxOutput — pilot: a 30k-per-window pool stopped
  everything after 14k spent with a 16k reserve; a run paused on WAITING_BUDGET shows in `jarvis ui` as paused,
  not failed (with the pool, how full it is, when it goes on), among the running ones, with Resume now; the feed
  says the run waits instead of "gave up"
- quota pools: unlimited hours (`quotaPools.<pool>.unlimited`: days and/or HH:MM in `timezone`; touching spans run
  together) — admission lets calls through, what was spent then is not counted in the window afterwards, a pool
  that waits goes on when its window frees or its unlimited hours begin; in those hours agent limits and
  `budget.perStep/perRun` grow `unlimitedScale` times (default 10, read at every check, grants on top); a call that
  does not fit its pool goes to the role's next model in another pool (`model.failover`, back once the first has
  room); `jarvis models` and the models button in `jarvis ui` (`∞ until 07:00`, `∞`) show it; the window in the
  popover shows input tokens too
- a decision made on the page (more budget, run again, an approval) goes on through the page when no terminal waits
  at the card (pilot: a terminal-started run left at its card did not continue after more was granted); Resume for a
  run nobody moves on (decided, SUSPENDED, RUNNING without its process, parked on a quota window)
- compaction: up to 8000 output tokens for the summary (pilot: a reasoning model spent 2000 thinking — one handoff
  empty, the next cut off, the agent re-read everything); an empty or cut-off summary is completed with the record of
  the calls and the task's sources as read (`context.compacted` … `fallback`); `design.collect` writes the issue and
  its Confluence pages as read to a `sources` artifact, an input of research and requirements
- `jarvis ui` New task offers research first and selects it
- research lists contradictions in the requirements (`contradictions`: both sides, sources, one question for the
  analyst) instead of copying a contradictory rule — pilot: both branches of one rule had «flag = true»; they come
  first in the document and are counted on the step's line; requirements settles each or treats it as blocking
- research tells this repository's requirements from other systems': theirs go to `dependencies` (what this
  repository needs from them), a contradiction names its `owner` — pilot: a backend method's spec read as front-end
  work and its inconsistency put to the front's analyst
- a file read again in a step: a pointer while its text is still above, else the text pinned against trimming;
  compaction shows while it runs (`context.compacting`) and leaves a line; unlimitedScale defaults to 10
- output styling: one palette for every command (`src/cli/style.ts`; headings bold, the subject bold cyan, metadata
  dim, commands cyan, ok/additions green, warnings yellow, errors/removals red), backticked spans render as commands,
  `jarvis diff` coloured like git, `candidates show` renders the markdown; errors are prefixed `error:`, notices go
  through `Output.note`; colour only on a terminal, `--color`/`--no-color`, `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`
- the course of a run (`src/app/journey.ts`, `src/cli/progress.ts`): a header with the plan, a line that stays per
  finished step (`[k/N]`, time, agent, calls, tokens, tools of the limit, retries, outcome, artifacts produced), loop
  backs and parking as lines; the live line under them; the run ends with a summary and `next` commands instead of
  the full status. `jarvis show <run> [artifact]` reads what a run produced — the pilot's `spec` stopped at
  "awaiting approval" with no command to read the spec; `workflow.loop` carries `max`
- agent limits: `agents.<id>.limits.{maxToolCalls,maxModelCalls}` in user/project config (and `JARVIS_AGENTS__…`);
  a result finished on a limit carries `budgetExhausted: tools|model` in its provenance and `agent.finish`, the step
  line, the summary and `jarvis show` say it may be incomplete, and the next agent gets the input marked `INCOMPLETE`
  (pilot: maps of large modules hit 60 tools and looked complete)
- first `spec` on a real bug (a form showed fields it should hide): root cause and fix found
  (a missing condition in a shared component), test conventions of AGENTS.md carried into the spec. Fixed from
  its logs: Node's fetch gave up on a response after 300 s (`UND_ERR_HEADERS_TIMEOUT`, read as "the gateway cuts
  at 5:00") — a model with a longer `timeoutMs` gets a dispatcher with raised header/body timeouts
  (`src/models/http.ts`); long code names (`isInvoiceRecalculationAvailable`) were masked as high-entropy in what
  agents read, and the agent then searched for the placeholder — `looksLikeCodeName`; `repo.search` with a file as
  `path` failed with spawn ENOTDIR; several tool calls in one answer overran the limit (41/40) — the rest are
  answered "skipped"; `jarvis show` renders result documents as markdown; long tasks are cut in the header
- decisions in place (`src/cli/gate.ts`, `src/cli/prompt.ts`): a foreground run that stops for a person asks at the
  terminal — the document in brief, read it whole, accept, send back (its open questions are asked one by one and
  the answers become the comment), or leave it — and goes on in the same process; clarifications use the attach
  mini-chat; `jarvis continue` (`c`) finds the waiting run without its id. Pilot: the way on was
  `jarvis approve 1a2b3c4d --request-changes --resume --comment "…"`
- `jarvis models stats [model] [--since]` (`src/app/modelStats.ts`): per model from the journal — answered/failed,
  success rate, retries, latency and output speed percentiles, tokens and cache share, finish reasons, failures
  grouped by reason/status/code with the length of the failed attempts (the same length every time is flagged as
  a cut-off), calls by agent
- the human loop closes: an agent sent back by `request_changes` gets the review (the decision's comment — answers
  to its open questions, what to change) as a binding section and its previous version as the first input, with
  the rule to revise it, take answered questions out of the open ones and use tools only for what the review raises.
  Pilot: the second pass of `spec` got the same inputs as the first, re-researched for 13 minutes, hit its tool
  limit and asked the answered questions again; a resumed step's report counts the tool calls made before the
  interruption
- an approved spec goes on (`src/app/handoff.ts`, workflow field `next:`): after a finished `spec`/`research` at a
  terminal Jarvis asks to go on and starts an `sdd` run after the approval with the artifacts and approvals carried
  over (provenance `import`); the engine enters a CREATED run at its `currentStep` when set; `jarvis continue <run>`
  does the same without a terminal, once
- less redundancy (pilot: `sdd` ran eleven agent steps for a one-line fix): `jarvis fix` (workflow `fix` — research,
  spec, approval, implementation with its tests, verify without a model, review, approval); `project.checks` runs
  the project's test*/typecheck* commands for the packages the change touches (jest: related tests only) in `fix`
  and `sdd`; a step's `when: { affects: … }` skips it when the impact analysis names nothing of that kind (`sdd`
  docs, telemetry); agents get the code earlier steps of the run (and of the run it went on from) read, in its
  current content, instead of reading it again; the course of a run tracks parallel children by step id

ADR-0001 §20 stage 12 (git hooks) — `f11ca47`:

- `jarvis hooks install|uninstall|status` — a thin `pre-push` shim honouring `core.hooksPath` and linked
  worktrees; a foreign hook is backed up on `--force` and restored on uninstall
- `jarvis prepush [--base] [--head] [--semantic|--no-semantic] [--hook]` — per pushed range: the
  deterministic standards check, `hooks.prePush.checks` (from `tools.local`), graph impact (dependents and
  covering tests the change did not touch), and the review agent only when that evidence or a
  semantic/hybrid standard asks for it; deterministic failures skip the paid step; review infrastructure
  trouble never blocks a push
- built-in workflow `review-diff` (one `review` step over the range, read-only); config `hooks.prePush`
  (`mode`, `standards`, `checks`, `semanticReview`, `blockOn`, `skipBranches`); the pushed branch is checked
  in a temporary worktree when it is not the checked-out one; tests include a real `git push` through the hook

ADR-0001 §20 stage 8 (context pressure) — `6a9c6d4` (ADR-0013):

- `src/context/`: effective window and threshold resolution (`byPhase` > `byModel` > default, kept ordered),
  tool-result trimming into blobs, handoff compaction with accumulating `Originals:`, resets bounded per step,
  `ContextManager` called before every model call; events `context.*`
- the agent loop gets a `compaction` role summariser (agent's own model as fallback), a tighter L3/L4 rebuild at
  `aggressive`, and a hard-trimming fallback when the summariser fails
- `jarvis context|compact|reset-context` over the transcript of a parked run (new checkpoint, resume continues
  from it); `knowledge.read` serves `blob:<ref>` and run artifacts; token calibration is clamped to a sane range

Stage 0 of the roadmap (ADR-0001 §20) — bootstrap:

- `jarvis init` — creates `~/.jarvis` (config, SQLite database, caches) and `.jarvis/` in the project
- `jarvis doctor` — environment, configuration with sources, database schema, secret references,
  egress policy summary (ADR-0016)
- `jarvis config show [--sources]` — resolved configuration and where every value comes from (ADR-0014)
- `jarvis db status|migrate|backup` — forward-only migrations with a backup (ADR-0014 §4)

Stage 1 — model runtime:

- `ModelGateway` (ADR-0001 §10): one door to LLMs — OpenAI-compatible adapter (corporate gateways,
  vLLM, Ollama, DeepSeek, Qwen), credentials injected at the transport, egress rule (ADR-0016),
  budget admission per quota-pool window (ADR-0018 §4–5), bounded retries with quota/rate-limit
  classification (ADR-0011 §1), usage and `model.call` events in SQLite, record/replay cassettes
  (ADR-0012 §4), self-calibrating token estimates (ADR-0013 §3)
- Model router by role, requirements and egress (ADR-0007 §3); structured output with bounded
  repair in `schema` / `json` / `text` modes (ADR-0007 §4)
- `jarvis models list` — models, egress, pools, window usage, probe state
- `jarvis models probe <id>` — canary requests; drift between config and reality shows up in `doctor`

Stage 2 — durable core:

- `RunStore` with the state machine (ADR-0001 §4 + `CANCELLED`), lease with epoch fencing, heartbeat
  and `--steal` semantics (ADR-0002 §5–6)
- `ArtifactStore` over a content-addressed `BlobStore`: immutable versions, provenance on every one,
  human edits as new versions with a unified diff, approvals bound to the exact content hash (ADR-0005)
- `CheckpointStore`, `StepHistoryStore` and the `EffectJournal` with the intended → done / verify
  protocol and lease fencing (`runEffect`, ADR-0002 §2–4)
- `jarvis status [run] [--all] [--watch N]` — active runs and pool budgets, or one run in detail:
  steps, checkpoint, artifacts and approvals, effects, events, tokens; `jarvis cancel <run>`

Stage 3 — resource control and the workflow engine (ADR-0011):

- `LocalWorkflowEngine`: steps as deterministic / agentic / approval / composite, transitions as a
  pure function with bounded back edges (ADR-0004), checkpoint on every step boundary, suspension
  to `WAITING_BUDGET` (quota, with `resumeAfter`) and `WAITING_HUMAN` (approval, unresolved effect,
  per-run/per-step cap), resume from the last checkpoint, cancel at a safe point, lease fencing
- Human gate modes `fail | artifact | skip-if-approved` with committed approvals in
  `.jarvis/approvals/<task>/<type>.json` (ADR-0009 §2, §4)
- Workflow definitions in YAML: built-in `sdd` (the ADR-0004 §6 graph; agents arrive in stage 5)
  and `smoke`; project overrides in `.jarvis/workflows/*.yaml`
- `jarvis work <task> [--workflow]`, `jarvis resume <run> [--steal]`,
  `jarvis approve <run> [--reject | --request-changes] [--comment] [--resume]`,
  `jarvis daemon [--interval] [--once]`

Stage 4 — tool platform:

- `Redactor` (ADR-0010): exact env/keychain literals, denied paths refused before reading,
  pattern detectors (cloud keys, tokens, JWT, PEM, bearer, basic-auth URLs, assignments, high
  entropy), deterministic per-run placeholders; applied to every tool result
- Tool Registry / Router (ADR-0001 §9): normalized capabilities with `network`, `access`, `effect`;
  policy = agent allowlist → profile deny → egress rule → write permission → non-interactive
  destructive ban; effects go through the journal with lease fencing; outputs capped with the full
  redacted text kept as a blob
- Local tools: `repo.read|list|search|write|edit`, `git.status|diff|log|commit|push` (push is a
  verified effect), `project.<name>` from `tools.local`, `shell.run` when `tools.shell: true`
- `WorktreeWorkspace` (ADR-0003): `jarvis/<task>/<run>` from the base commit, setup hook,
  checkpoint = commit with `Jarvis-*` trailers, resume = reset + clean; `jarvis diff|apply|gc`

Stage 5 + 7 — agents and the SDD workflow:

- `AgentDefinition` (ADR-0001 §6): instructions, model role, least-privilege capability set,
  requirements, result schema with declared outcomes, limits; project override of the instructions
  in `.jarvis/agents/<id>.md`
- `AgentRuntimeRunner`: layered context (byte-stable system layer, task + output contract, loop
  reasons, input artifacts, `.jarvis/knowledge/*.md`), tool-calling loop through the policy-filtered
  tools, transcript checkpoint every N calls and restore on resume, structured finalization,
  `invalid-output` artifact on failure
- Built-in agents `research`, `specification`, `impact`, `plan`, `implementation`, `test`, `review`
  with JSON result artifacts; the built-in `sdd` workflow now runs end to end:
  research → spec → approval → impact → plan → implementation → verify → review with back edges

Stage 6 — MCP and credentials (ADR-0017):

- MCP client pool on the official TypeScript SDK (`stdio`, streamable `http`, legacy `sse`), lazy
  connections, `tools/list` cached in `~/.jarvis/cache/mcp/<server>.json`
- Profiles `atlassian` (Jira/Confluence) and `bitbucket` map server tools onto normalized
  capabilities (`jira.get`, `jira.comment`, `bitbucket.pr.create`, …); effects carry a marker and
  are verified through the same server after a resume (ADR-0002 §3). Servers without a profile
  expose `mcp.<server>.<tool>` as unverifiable effects, or as pure reads with `readOnly: true`
- `jarvis mcp list [--refresh]` — discovered / exposed / denied / unmapped / "discovered, not allowed"
- `jarvis auth set|status|remove` — credentials in the OS keychain (macOS Keychain, libsecret; a
  0600 file as the fallback) under the actor; values go only into transports and are redacted from
  every tool output
- `jarvis work` preflight: every server the workflow's agents may reach must answer `tools/list`
  before a run is created; `jarvis doctor` reports credentials, discovery state and unknown profiles

Stage 8 — context engine: standards, skills and knowledge (ADR-0020, ADR-0021 §3):

- Typed `Standard`s in `.jarvis/standards/<id>.md` (front matter: scope, severity, verification
  with a mandatory `check` for deterministic/hybrid) and `Skill`s in `.jarvis/skills/<id>/`
  (`skill.yaml` + `instructions.md`); built-in generic skills, project overrides by id, user-level
  additions that can never be `required`
- Deterministic resolver → `EngineeringContextPackage` per agent call: most specific skills
  (capped by `knowledge.maxSkills`), standards by scope plus the skills' `requiredStandards`,
  knowledge by front-matter scope; rendered as layer L4 with a fair-share budget and
  "available on request" refs served by the `knowledge.read` tool; the package's refs land in the
  result artifact's provenance
- `standards.check` step inside the `sdd` `verify` composite: pattern and tool checks over the
  files changed since the base commit → `standards_violation` sends the implementation back with
  the violations as loop reasons
- Review agent reports `standardsChecked` and proposes `candidates`; stored as `candidate`
  artifacts, promoted or rejected by a human: `jarvis candidates list|promote|reject`
- `jarvis standards list|check`, `jarvis skills list`; `stack:` in project config with detection
  from the workspace; architecture fitness test keeps the core stack-neutral

Stage 9 + 10 — human collaboration (ADR-0019):

- One `interactions` entity for every human touchpoint (approval, clarification, review,
  conflict) with messages; `runs.waitingFor` says what a parked run waits for; `jarvis threads`
- `requirements` agent between research and spec: contradictions, missing cases, unverifiable
  requirements; a blocking gap → `needs_clarification` → the run parks on a clarification thread
- Threads: `jarvis answer <thread|run> "…"` (asynchronous; the clarifier asks the next question or
  proposes a rule), `--accept` / `--rule` / `--reject`, `jarvis attach <run>` for the live terminal
  mini-chat (`a` / `e <rule>` / `r` / `q`); `human.clarification.maxTurns`; the resolution is a
  `clarification` artifact every later agent sees as binding — the transcript stays in the thread
- Final gate `approve-impl` on the implementation; Review Mode v1: `// REVIEW: …` markers →
  `jarvis review submit` (ids written back as `REVIEW(R-n):`, `review-package` artifact) →
  `review-analysis` agent classifies CODE / SPEC_CORRECTION / REQUIREMENT_CORRECTION / QUESTION /
  KNOWLEDGE_CANDIDATE / SUGGESTION and routes the graph (fix loop, back to spec or requirements,
  clarification thread, candidates); markers are removed on `jarvis apply`
- Human edits in the worktree become a `human edit` checkpoint (`Jarvis-Kind: human-edit`) on
  resume — never reset away; `human.gates.<type>.required: false` switches a gate off

Stage 11 (part) — CI mode and run transfer (ADR-0009):

- `jarvis ci <task>` — the same workflow under the `ci` profile (or `--profile <name>`):
  non-interactive, read-only checkout; exit 10/11 at a human gate with a markdown job summary
  (`--summary`, `$GITHUB_STEP_SUMMARY`), `approval-request.json` under the run's state dir and,
  with `--bundle`, the run exported; `humanGate: fail` exits 12 with a `policy:` reason
- `jarvis export <run>` / `jarvis import <bundle>` — one gzipped JSON with the run's rows,
  artifacts and blobs, effects, approvals, threads and the workspace patch; import rebuilds the
  worktree from the base commit with the patch applied and refuses duplicates
- `jarvis approve --commit` writes `.jarvis/approvals/<task>/<type>.json` and commits it, so a
  later CI run with `humanGate: skip-if-approved` passes that gate for the same content

Stage 12 — specialised agents (ADR-0001 §6):

- `docs` (documentation in step with the change), `telemetry` (events/metrics with privacy notes;
  `spec_gap` sends the spec back) run inside the `verify` composite next to tests and standards;
  `release-notes` closes the workflow after the final gate with publishable markdown
- The review agent sees docs and telemetry artifacts as inputs

Retrieval (ADR-0015 v0.1–v0.3½, ports for v0.5):

- FTS5 index (migration 0004) over knowledge sections, standards, skills and run artifacts,
  re-indexed by unit version; `.jarvis/knowledge/glossary.md` expands queries across the
  business-language / code gap deterministically (every expansion is in the trace)
- `Embedder` port with an OpenAI-compatible `/embeddings` implementation behind
  `knowledge.retrieval.embeddings` (off until the ADR-0015 §6 gate), vectors keyed by unit version and
  embedder id; Reciprocal Rank Fusion of lexical and semantic lists, `retrievalPath` on every hit
- Once more knowledge documents match a task than `knowledge.retrieval.rankAbove`, the index orders
  them (nothing is dropped); `knowledge.search` tool for agents, `jarvis knowledge index|search`,
  MCP `knowledge.search` on the same path

Stage 14 — IDE integration and evals (ADR-0017 §7, ADR-0012):

- `jarvis mcp serve` — Jarvis as a read-only MCP server on stdio for IDEs and other agents:
  `knowledge.search` (knowledge, standards, skills), `spec.get`, `run.status`, `context.inspect`
  (the exact EngineeringContextPackage an agent would get)
- `jarvis evals run --suite <s> [--mode record|replay|live] [--variant k=v]` — workflow-tier
  cases (`evals/<suite>/<case>/case.yaml` + fixture repository + cassette): gates auto-approved,
  scored deterministically (tests, file recall, acceptance coverage, required sources, loops,
  tokens) with the headline *successes per 10k output tokens*; results in `evals/results/`,
  `jarvis evals baseline <s>` and `jarvis evals diff <s> [--tolerance]` (non-zero on regression)

Stage 13 (phase 2) — TypeScript adapter and the incremental Project Graph (ADR-0008, ADR-0021 §6, §8):

- `TypeScriptAdapter` (in-process, ts-morph): detection, `graph` and snapshot-backed
  `codeIntelligence` → TypeScript projects run at level FULL
- `TypeScriptExtractor`: facts per file (modules, exported symbols, imports, test relations),
  sorted and content-addressed in `~/.jarvis/cache/graph/<repo>/blobs/<blobSha>.v<n>.json` —
  shared by every branch and worktree; snapshots per tree in SQLite (migration 0003), last 5 kept
- `jarvis knowledge update [--full]` (facts from cache, edges per tree, reuse when the tree is
  unchanged) and `jarvis knowledge status [--verify]` (recompute without cache and compare —
  the determinism check); `graph.impact` / `graph.neighbors` tools for agents, the impact agent
  uses them as evidence and says when there is no snapshot

Stage 13 (phase 1) — capability layer (ADR-0021 §2–3, §7):

- Stack-neutral contracts in `src/core/capabilities/contracts.ts` (`LanguageAdapter`,
  `CodeIntelligence`, `DiagnosticsProvider`, `ProjectGraphExtractor`, neutral symbol/graph types)
- `CapabilityRegistry.discover` → the `project-capabilities` artifact written by the `discover`
  step that now opens `sdd`: configured vs detected stacks, adapters, effective commands, where
  each capability comes from (project / adapter / missing) and the level FULL / BASIC /
  UNSUPPORTED with reasons; `status` shows the level; UNSUPPORTED stops the run with a policy
  reason. No adapter ships yet (TS on ts-morph is next), so every project runs at BASIC.
