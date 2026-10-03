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
