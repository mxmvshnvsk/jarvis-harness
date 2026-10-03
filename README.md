# jarvis-harness

**Jarvis** is a durable AI engineering runtime for closed corporate environments. A task goes through a
specification-driven workflow — research, requirements, spec, human approval, impact, plan,
implementation, verification, review, approval, release notes — executed by least-privilege agents over
replaceable LLMs, with the project's own standards, skills and knowledge in every call, and every step,
decision and side effect recorded in SQLite.

> Jarvis ≠ AI coding chat. Jarvis = engineering runtime + SDD workflows + project knowledge +
> context policies + resource governance + tools + replaceable LLMs.

- **Durable** — a run survives a killed process, an exhausted quota window and a human who answers tomorrow.
- **Closed-contour safe** — `dataClass` decides which models and networks are allowed; secrets never reach a model.
- **The project's rules, not the model's habits** — standards with deterministic checks, skills, a glossary.
- **Humans where it matters** — approval gates, clarification threads, review by `// REVIEW:` markers in the code.
- **Replaceable** — any OpenAI-compatible endpoint, MCP servers for Jira/Confluence/Bitbucket, language adapters.
- **Measurable** — budgets per quota pool, tokens and events per step, evals on fixture repositories.

![jarvis work → approve → diff → apply](docs/assets/work.gif)

## Requirements

- Node.js ≥ 22.18 (native TypeScript execution and `node:sqlite`; no native modules)
- pnpm (the repository pins it through `packageManager`)
- git — runs work in a git worktree, so the project must be a git repository
- an OpenAI-compatible model endpoint; the OS keychain is optional (a `0600` file is the fallback)

## Install

```sh
git clone <repo-url> jarvis-harness && cd jarvis-harness
pnpm install
pnpm build
pnpm link --global      # puts `jarvis` on PATH (run `pnpm setup` once if pnpm has no global bin yet)
jarvis --help
```

No global link? `node bin/jarvis.js <command>` runs the built CLI, and `pnpm dev <command>` runs it from
sources.

## Kickstart

Go to the repository you want Jarvis to work on.

**1. Initialise** — creates `~/.jarvis/config.yaml` (machine, models) and `.jarvis/` in the project
(policy, knowledge, standards, workflows):

```sh
jarvis init
```

**2. Configure a model** in `~/.jarvis/config.yaml`: endpoint, `egress: private|cloud`, context window,
and which model plays which role (`research`, `implementation`, `review`):

```yaml
models:
  corp-llm:
    provider: openai-compatible
    baseUrl: https://llm.corp.local/v1
    model: deepseek-flash
    auth: { type: bearer, token: keychain:corp-llm }
    egress: private
    contextWindow: 128000
    maxOutput: 8192
    supports: { tools: true, jsonMode: true }
roles:
  research:       { models: [corp-llm] }
  implementation: { models: [corp-llm] }
  review:         { models: [corp-llm] }
```

**3. Store the token and check the setup:**

```sh
jarvis auth set corp-llm      # into the OS keychain; secrets are never written in YAML
jarvis models probe corp-llm  # what the model really supports: tools, json, schema
jarvis doctor                 # everything that would stop a run, in one list
```

**4. Tell Jarvis how to verify your project** in `.jarvis/project.yaml`:

```yaml
version: 1
tools:
  local: { tests: "pnpm vitest run", typecheck: "pnpm tsc --noEmit", lint: "pnpm biome check ." }
```

**5. Run a task:**

```sh
jarvis work ABC-42                 # runs the `sdd` workflow in its own git worktree
jarvis status ABC-42 --watch 5     # steps, artifacts, tokens, what it waits for
jarvis approve <run> --resume      # approve the spec; later, the implementation
jarvis diff <run> && jarvis apply <run>   # one squash commit on your branch
```

A run that needs you exits with code `10`; close the terminal any time and continue with
`jarvis resume <run>`. Exit codes: `0` done · `10` waits for a human · `11` waits for quota ·
`12` policy denied · `13` lease lost.

The full walkthrough — project policy, knowledge, clarifications, review — is in
[docs/QUICKSTART.md](docs/QUICKSTART.md).

### Useful next steps

```sh
jarvis onboard               # scan an existing repo: suggest tools.local, write architecture.md/conventions.md skeletons
jarvis spec ABC-42              # only research → requirements → spec, up to its approval
jarvis hooks install            # standards, checks and impact analysis before every git push
jarvis explain src/foo.ts:42    # why this line exists: task → spec → sources → tool calls
jarvis mcp serve                # Jarvis as a read-only MCP server for an IDE or another agent
jarvis ci ABC-42 --bundle run.json.gz   # the same workflow in CI, handed over to a developer
```

## Documentation

| Read this | To learn |
|---|---|
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | the pilot walkthrough from an empty machine to an applied result |
| [docs/overview.md](docs/overview.md) | **how it works**: layers, concepts, the life of a run, on-disk layout, exit codes |
| [docs/adr/0001-target-architecture.md](docs/adr/0001-target-architecture.md) | **architecture**: the target design, what is implemented, what is not |
| [docs/configuration.md](docs/configuration.md) | **how to configure**: every key of `config.yaml` and `project.yaml`, env overrides, profiles |
| [docs/cli.md](docs/cli.md) | every command and option |
| [docs/workflows.md](docs/workflows.md) | the engine, the `sdd` graph, agents and their contracts, context management, events |
| [docs/knowledge.md](docs/knowledge.md) | standards, skills, knowledge documents, glossary, retrieval, the project graph |
| [docs/human.md](docs/human.md) | gates, clarification threads, Review Mode, manual edits |
| [docs/integrations.md](docs/integrations.md) | models, MCP profiles, `jarvis mcp serve` for IDEs, the keychain |
| [docs/ci.md](docs/ci.md) | CI mode and run bundles |
| [docs/evals.md](docs/evals.md) | workflow evals, cassettes, baselines |
| [docs/security.md](docs/security.md) | egress, secret redaction, tool policy, effects, leases |
| [docs/extending.md](docs/extending.md) | language adapters, tools, MCP profiles, agents, workflows |
| [docs/adr/](docs/adr/) | the decisions behind it: ADR-0001 … ADR-0021 |
| [docs/process/stages.md](docs/process/stages.md) | how it was built, stage by stage |

The documentation index with one-line descriptions is [docs/README.md](docs/README.md).

## Repository layout

```
bin/            the `jarvis` executable (runs the built CLI)
src/cli/        commands and output
src/app/        runtime assembly: engine, status, bundles, explain
src/orchestration/  workflow engine, leases, effects, worktrees
src/agents/     agent definitions and the tool-calling loop
src/context/    context pressure: trimming, compaction, reset
src/models/     model gateway, router, token estimates
src/tools/      tool router, local tools, redaction
src/knowledge/  standards, skills, retrieval, project graph
src/adapters/   language adapters (TypeScript today)
src/hooks/      git hooks and pre-push checks
src/storage/    SQLite stores and migrations
tests/          vitest suites; docs/  documentation and ADRs
```

## Development

```sh
pnpm install
pnpm check          # typecheck + lint (biome) + tests (vitest)
pnpm dev doctor     # run the CLI from sources
pnpm build          # emit dist/
```

## Status

Implemented: the whole roadmap of ADR-0001 §20 — durable core, workflow engine, agents and the `sdd`
workflow, MCP, knowledge, human collaboration, CI mode, the TypeScript adapter and project graph, the
context engine, git hooks, the daemon and evals. Not done yet: telemetry export, a native Anthropic
adapter, adapters for other languages, enabling embeddings, and a pilot on a real repository — see
[ADR-0001, appendix B](docs/adr/0001-target-architecture.md#приложение-b-что-не-реализовано).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
