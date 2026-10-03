# jarvis-harness

Jarvis — a durable AI engineering runtime for closed corporate environments: spec-driven
workflows, versioned project knowledge, context policies, resource governance, replaceable LLMs.

> Jarvis ≠ AI coding chat. Jarvis = engineering runtime + SDD workflows + project knowledge +
> context policies + resource governance + tools + replaceable LLMs.

Architecture and every decision live in [`docs/adr/`](docs/adr/). Start with ADR-0001 (target
architecture); ADR-0002…0018 refine it.

## Status

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

Configuration precedence: CLI flags → `JARVIS_*` env → `.jarvis/project.yaml` → `~/.jarvis/config.yaml`
→ defaults; profiles (`--profile ci`) may only narrow. Secrets are references (`env:VAR`,
`keychain:ID`), never literals.

## Requirements

Node.js ≥ 22.18 (native TypeScript execution and `node:sqlite`; no native modules), pnpm.

## Development

```sh
pnpm install
pnpm check          # typecheck + lint (biome) + tests (vitest)
pnpm dev doctor     # run the CLI from sources
pnpm build          # emit dist/
node bin/jarvis.js  # run the built CLI
```

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
