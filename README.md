# jarvis-harness

**Jarvis** is a durable AI engineering runtime for closed corporate environments: a task goes through a
specification-driven workflow — research, requirements, spec, human approval, impact, plan,
implementation, verification, review, approval, release notes — executed by least-privilege agents
over replaceable LLMs, with the project's own standards, skills and knowledge in every call, and every
step, decision and side effect recorded in SQLite.

> Jarvis ≠ AI coding chat. Jarvis = engineering runtime + SDD workflows + project knowledge +
> context policies + resource governance + tools + replaceable LLMs.

## Why

- **Durable.** A run survives a killed process, an exhausted quota window and a human who answers
  tomorrow. Checkpoints at every step boundary, a lease with fencing, an effect journal so a Jira
  comment or a `git push` never happens twice (ADR-0002).
- **Closed-contour safe.** `dataClass` decides which models and networks are allowed; secrets are
  references only and are redacted from every tool output before a model sees it (ADR-0010, ADR-0016).
- **The project's rules, not the model's habits.** Standards with deterministic checks, skills per kind
  of change, knowledge documents and a business-term glossary — selected deterministically per agent
  call and verified in the workflow (ADR-0015, ADR-0020).
- **Humans where it matters.** Approval gates bound to the exact content hash, clarification threads
  when requirements have a gap, review by `// REVIEW:` markers in the code, manual edits that are kept
  (ADR-0019).
- **Replaceable models and tools.** Any OpenAI-compatible endpoint, roles per agent, MCP servers mapped
  onto normalized capabilities, a stack-neutral core with language adapters (ADR-0007, ADR-0017,
  ADR-0021).
- **Measurable.** Budgets per quota pool, run and step; tokens and events per step; evals on fixture
  repositories with the headline *successes per 10k output tokens* (ADR-0012, ADR-0018).

## How it looks

A task from start to applied result — approvals at the spec and at the implementation:

![jarvis work → approve → diff → apply](docs/assets/work.gif)

The requirements agent finds a gap it cannot close itself; the run parks on a thread and the human
answers in a terminal mini-chat:

![clarification thread with jarvis attach](docs/assets/clarify.gif)

Review by markers in the code: `// REVIEW:` comments become a review package, an agent classifies
them and routes the workflow; every comment has a lifecycle:

![jarvis review submit and review status](docs/assets/review.gif)

## Quick start

```sh
pnpm install && pnpm build && pnpm link --global     # Node ≥ 22.18, no native modules
jarvis init                                          # ~/.jarvis/config.yaml + .jarvis/ in the project
$EDITOR ~/.jarvis/config.yaml                        # models: endpoint, egress, context window …
jarvis auth set corp-llm                             # token into the OS keychain
jarvis doctor                                        # everything that would stop a run, in one list
jarvis work ABC-42                                   # run the sdd workflow for a task
jarvis status <run> --watch 5                        # … until it waits for you
jarvis approve <run> --resume                        # the spec; later the implementation
jarvis diff <run> && jarvis apply <run>              # one squash commit on your branch
jarvis hooks install                                 # optional: standards, checks and impact before every git push
```

The full pilot walkthrough is in [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Documentation

| | |
|---|---|
| [docs/overview.md](docs/overview.md) | architecture, concepts, the life of a run, on-disk layout, exit codes |
| [docs/cli.md](docs/cli.md) | every command |
| [docs/configuration.md](docs/configuration.md) | every configuration key, env overrides, profiles |
| [docs/workflows.md](docs/workflows.md) | the engine, the `sdd` graph, agents and their contracts |
| [docs/knowledge.md](docs/knowledge.md) | standards, skills, knowledge, glossary, retrieval, project graph |
| [docs/human.md](docs/human.md) | gates, clarification threads, Review Mode, manual edits |
| [docs/integrations.md](docs/integrations.md) | models, MCP profiles, `jarvis mcp serve` for IDEs, keychain |
| [docs/ci.md](docs/ci.md) · [docs/evals.md](docs/evals.md) | CI mode and run bundles · workflow evals |
| [docs/security.md](docs/security.md) · [docs/extending.md](docs/extending.md) | egress, redaction, policy, effects · adapters, tools, agents |
| [docs/adr/](docs/adr/) | the decisions: [ADR-0001 target architecture](docs/adr/0001-target-architecture.md), ADR-0002 … ADR-0021 |
| [docs/process/stages.md](docs/process/stages.md) | how it was built, stage by stage |

## Status

The roadmap of [ADR-0001 §20](docs/adr/0001-target-architecture.md) is implemented and tested: bootstrap, model runtime, durable core, workflow engine, tool platform with
redaction, agents and the `sdd` workflow, MCP and credentials, standards/skills/knowledge with retrieval,
human collaboration (gates, threads, Review Mode), CI mode and run transfer, specialised agents, the
capability layer with a TypeScript adapter and the incremental project graph, IDE integration
(`jarvis mcp serve`), the daemon and evals, the context engine with pressure thresholds, compaction and manual controls (`jarvis context|compact|reset-context`), and the pre-push hook (`jarvis hooks install`, `jarvis prepush`).

Not done yet (ADR-0001, appendix B): telemetry export and `jarvis stats` (with the prefix cache-hit metric of ADR-0013), automatic workflow branching by change risk, a
native Anthropic provider adapter, adapters for other languages (C#/.NET first), the embeddings gate of
ADR-0015 §6 — and the real-repository pilot.

## Requirements

Node.js ≥ 22.18 (native TypeScript execution and `node:sqlite`), pnpm. No native modules; the OS
keychain is optional (a 0600 file is the fallback).

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
