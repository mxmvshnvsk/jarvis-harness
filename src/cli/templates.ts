/** Files written by `jarvis init`. Comments reference the ADRs that define each section. */

export const USER_CONFIG_TEMPLATE = `# ~/.jarvis/config.yaml — this machine and this person (ADR-0017 §1).
# Endpoints and credential references live here; roles and policy live in the project.
# Secrets are never literal: use env:VAR or keychain:ID (ADR-0014 §1).
version: 1

# actor:
#   id: me@corp.local          # or set JARVIS_ACTOR; otherwise git config user.email is used (ADR-0006)

quotaPools:
  # corp-default:              # ADR-0018 §4
  #   window: { minutes: 20, kind: sliding }
  #   limits: { outputTokens: 60000, requests: 300, concurrency: 2 }
  #   soft: 0.8

models:
  # deepseek-flash:            # ADR-0007, ADR-0017 §2
  #   provider: openai-compatible
  #   baseUrl: https://llm.corp.local/v1
  #   model: deepseek-flash
  #   auth: { type: bearer, token: keychain:corp-llm }
  #   egress: private          # private | cloud — required (ADR-0016)
  #   quotaPool: corp-default
  #   contextWindow: 128000
  #   maxOutput: 8192
  #   supports: { tools: true, jsonSchema: false, jsonMode: true, prefixCache: true }
  #   tokenizer: deepseek

roles:
  # research: { models: [deepseek-flash] }
  # implementation: { models: [deepseek-flash] }
  # review: { models: [deepseek-flash], maxOutput: 4096 }
  # compaction: { models: [deepseek-flash] }
`;

export const PROJECT_CONFIG_TEMPLATE = `# .jarvis/project.yaml — the project and the team (ADR-0017 §1). Versioned with the repository.
version: 1

# public | internal | confidential. Omitted means confidential (ADR-0016 §1).
dataClass: confidential

roles:
  # research:       { models: [deepseek-flash] }   # order = preference (ADR-0007 §3)
  # implementation: { models: [deepseek-flash] }
  # review:         { models: [deepseek-flash], maxOutput: 4096 }
  # compaction:     { models: [deepseek-flash] }

mcp:
  servers: {}
  # jira:                      # ADR-0017 §3
  #   transport: http
  #   url: https://mcp.corp.local/atlassian
  #   auth: { type: bearer, token: keychain:atlassian }
  #   network: intranet        # none | intranet | internet (ADR-0016); defaults to the profile's
  #   profile: atlassian       # built-in: atlassian, bitbucket; or { base: atlassian, map: { … } }
  #   allow: [jira.get, jira.search, jira.comment]   # empty = every profile capability
  #   deny: [jira.transition]
  # elastic:                   # no profile: tools appear as mcp.elastic.<tool>
  #   transport: http
  #   url: https://mcp.corp.local/elastic
  #   readOnly: true           # all tools pure; otherwise each is an unverifiable effect
  # bitbucket:
  #   transport: stdio
  #   command: node
  #   args: [/opt/mcp/bitbucket/index.js]
  #   env: { BB_TOKEN: keychain:bitbucket }   # stored with: jarvis auth set bitbucket
  #   profile: bitbucket

tools:
  local: {}
  # tests: "pnpm vitest run"
  # typecheck: "pnpm tsc --noEmit"

workspace:
  mode: worktree               # ADR-0003
  # setup: "pnpm install --offline --frozen-lockfile"

budget:                        # ADR-0018 §4 — caps per run and per step
  perRun: {}
  perStep: {}

profiles:                      # ADR-0009 §1 — a profile may only narrow
  ci:
    interactive: false
    workspace: { mode: cwd, allowWrites: false }
    humanGate: artifact
    mcp: { deny: ["*.comment", "*.transition"] }
`;

export const KNOWLEDGE_README = `# Project knowledge

Versioned project knowledge read by Jarvis (ADR-0001 §8). Keep it short and factual:

- architecture.md — subsystems, boundaries, where things live
- domain.md — business rules and vocabulary
- conventions.md — code conventions and review expectations
- glossary.md — business term → code symbols (ADR-0015 §3)

Optional front matter narrows a document to a scope (ADR-0020 §3):

    ---
    tags: [orders]
    paths: ["src/orders/**"]
    stacks: [typescript]
    ---
`;

export const STANDARDS_README = `# Standards

One file per rule, \`<id>.md\` with YAML front matter (ADR-0020 §1–2). \`required\` standards with a
deterministic check send the implementation back when violated; semantic ones are checked in review.

    ---
    id: no-console
    version: 1
    title: No console output in library code
    scope: { paths: ["src/**"] }
    severity: required            # required | recommended
    verification:
      kind: deterministic         # deterministic | semantic | hybrid
      check: { pattern: { glob: "src/**/*.ts", mustNot: 'console\\.log' } }
      # or: check: { tool: project.lint }
    tags: [logging]
    ---
    Library code writes through the logger, never to the console.

\`jarvis standards list\` and \`jarvis standards check\` show what applies and what is violated.
`;

export const SKILLS_README = `# Skills

One directory per skill: \`<id>/skill.yaml\` + \`<id>/instructions.md\` (ADR-0020 §1). The resolver
picks the most specific skills for the task's stack, paths and kind; project skills override the
built-in \`sdd-implementation\`, \`unit-testing\` and \`refactor\` by id.

    id: react-component-change
    version: 1
    appliesTo: { stacks: [react], paths: ["src/**/components/**"], kinds: [feature, change] }
    requiredStandards: [STD-REACT-*]
    verification: [project.tests, project.lint]

\`jarvis skills list\` shows the selection for this project.
`;

export const GITIGNORE_ENTRIES = ["# jarvis runtime state (ADR-0001 §3)", ".jarvis/runs/", ".jarvis/cache/"];
