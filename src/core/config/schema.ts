import { z } from "zod";
import { isSecretRef, looksLikeSecretKey, SecretRefSchema } from "./secrets.ts";

/* ------------------------------------------------------------------------------------------------
 * Shared enums
 * ---------------------------------------------------------------------------------------------- */

/** ADR-0016 §1 — data class of a project; the default is the safest one. */
export const DataClassSchema = z.enum(["public", "internal", "confidential"]);
export type DataClass = z.infer<typeof DataClassSchema>;
export const DATA_CLASS_ORDER: Record<DataClass, number> = { public: 0, internal: 1, confidential: 2 };

/** ADR-0016 §1 — where a model endpoint lives. Required on every model. */
export const EgressSchema = z.enum(["private", "cloud"]);
export type Egress = z.infer<typeof EgressSchema>;

/** ADR-0016 §1 — network reach of a tool/MCP server. Unknown means `internet` (worst case). */
export const NetworkSchema = z.enum(["none", "intranet", "internet"]);
export type Network = z.infer<typeof NetworkSchema>;

export const HumanGateModeSchema = z.enum(["fail", "artifact", "skip-if-approved"]);
export type HumanGateMode = z.infer<typeof HumanGateModeSchema>;

export const WorkspaceModeSchema = z.enum(["worktree", "cwd"]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

/* ------------------------------------------------------------------------------------------------
 * Models and quota (ADR-0007, ADR-0017 §2, ADR-0018 §4)
 * ---------------------------------------------------------------------------------------------- */

export const ModelProviderSchema = z.enum(["openai-compatible", "anthropic", "openai", "ollama"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer"), token: SecretRefSchema }),
  z.strictObject({ type: z.literal("header"), header: z.string().min(1), token: SecretRefSchema }),
]);
export type ModelAuth = z.infer<typeof ModelAuthSchema>;

/**
 * How long a reasoning model thinks before it answers (`reasoning_effort` of OpenAI-compatible APIs).
 * Pilot: up to 10k output tokens of reasoning before a one-line answer, counted in completion_tokens
 * and in the output quota; the gateway does not pass the parameter yet — set it once it does.
 */
export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ModelSupportsSchema = z.strictObject({
  tools: z.boolean().default(false),
  parallelTools: z.boolean().default(false),
  jsonSchema: z.boolean().default(false),
  jsonMode: z.boolean().default(false),
  systemRole: z.boolean().default(true),
  reasoning: z.boolean().default(false),
  prefixCache: z.boolean().default(false),
});
export type ModelSupports = z.infer<typeof ModelSupportsSchema>;

export const ModelConfigSchema = z.strictObject({
  provider: ModelProviderSchema,
  baseUrl: z.url().optional(),
  model: z.string().min(1),
  auth: ModelAuthSchema.default({ type: "none" }),
  headers: z.record(z.string(), z.string()).prefault({}),
  egress: EgressSchema,
  quotaPool: z.string().min(1).optional(),
  contextWindow: z.int().positive(),
  /** `reasoning_effort` for every call to this model, unless an agent sets its own. */
  reasoningEffort: ReasoningEffortSchema.optional(),
  /**
   * The gateway caches prompt prefixes but does not say so in `usage` (yet): a call within `ttlSeconds`
   * of the previous one of its step, sharing a prefix of at least `minTokens`, counts that prefix as
   * cached — an estimate («≈»), until the gateway reports `cached_tokens`. Budgets of input tokens
   * count what was not cached. Pilot: two budget stops in a run on 40M input tokens, ~95% of them a
   * prefix the cluster had cached.
   */
  prefixCache: z
    .strictObject({
      ttlSeconds: z.int().positive().default(120),
      minTokens: z.int().nonnegative().default(8192),
    })
    .optional(),
  maxOutput: z.int().positive(),
  supports: ModelSupportsSchema.prefault({}),
  tokenizer: z.string().min(1).optional(),
  /** How long the server may stay silent: before the answer starts and between its streamed chunks. */
  timeoutMs: z.int().positive().default(120_000),
  maxConcurrency: z.int().positive().default(2),
  /**
   * Ask for the answer as a stream (SSE). On by default: headers arrive at once, so a long answer
   * is not cut by a header timeout and the progress line shows it coming. A gateway that refuses
   * streaming is asked again without it, once per process.
   */
  stream: z.boolean().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const QuotaWindowSchema = z.strictObject({
  minutes: z.int().positive(),
  kind: z.enum(["sliding", "fixed"]).default("sliding"),
});

export const QuotaLimitsSchema = z.strictObject({
  outputTokens: z.int().positive().optional(),
  inputTokens: z.int().positive().optional(),
  requests: z.int().positive().optional(),
  concurrency: z.int().positive().optional(),
});

const HHMM = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "a time of day as HH:MM");

/** Hours with no limits (the platform's nights, weekends): days, a time span, or both. */
export const UnlimitedSpanSchema = z
  .strictObject({
    days: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .min(1)
      .optional(),
    from: HHMM.optional(),
    to: HHMM.optional(),
  })
  .refine((s) => s.days !== undefined || s.from !== undefined || s.to !== undefined, {
    message: "a span needs days, from/to, or both",
  });

const knownZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const QuotaPoolSchema = z.strictObject({
  window: QuotaWindowSchema,
  limits: QuotaLimitsSchema.prefault({}),
  soft: z.number().min(0).max(1).default(0.8),
  /** Hours when the platform does not limit the pool: admitted without a check, not counted after. */
  unlimited: z.array(UnlimitedSpanSchema).default([]),
  /**
   * In the unlimited hours the agents' call limits and the run's and the step's budget (perStep,
   * perRun) of calls on this pool grow this many times: the pool lets everything through, a step
   * that loops still ends.
   */
  unlimitedScale: z.number().min(1).default(10),
  /** The zone of `unlimited` (IANA, e.g. Europe/Moscow); none — the machine's. */
  timezone: z.string().refine(knownZone, "an IANA time zone, e.g. Europe/Moscow").optional(),
});
export type QuotaPool = z.infer<typeof QuotaPoolSchema>;

export const RoleConfigSchema = z.strictObject({
  models: z.array(z.string().min(1)).min(1),
  maxOutput: z.int().positive().optional(),
});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

/* ------------------------------------------------------------------------------------------------
 * MCP servers (ADR-0017 §3)
 * ---------------------------------------------------------------------------------------------- */

const McpProfileSchema = z.union([
  z.string().min(1),
  z.strictObject({
    base: z.string().min(1),
    /** Additional pure capabilities only; effects cannot be declared from config (ADR-0017 §4). */
    map: z.record(z.string(), z.string()).prefault({}),
  }),
]);

const McpServerCommonShape = {
  /** Defaults to the profile's network, else `internet` (ADR-0017 §4). */
  network: NetworkSchema.optional(),
  profile: McpProfileSchema.optional(),
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
  readOnly: z.boolean().default(false),
  /** How long one tool call may take (ms); the MCP client's default is 60 s (a large design frame takes longer). */
  timeoutMs: z.int().positive().optional(),
  /**
   * Calls per minute to this server, for the user across processes; over the profile's and
   * `mcp.defaults`. 0 — no limit. A 429 from the server is waited out and asked again either way.
   */
  rateLimit: z.strictObject({ rpm: z.int().nonnegative() }).optional(),
};

const McpStdioEnvSchema = z.record(z.string(), z.string()).superRefine((env, ctx) => {
  for (const [key, value] of Object.entries(env)) {
    if (looksLikeSecretKey(key) && !isSecretRef(value)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `"${key}" looks like a secret; use env:VAR or keychain:ID instead of a literal`,
      });
    }
  }
});

export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: McpStdioEnvSchema.prefault({}),
    cwd: z.string().min(1).optional(),
    ...McpServerCommonShape,
  }),
  z.strictObject({
    transport: z.literal("http"),
    url: z.url(),
    auth: ModelAuthSchema.default({ type: "none" }),
    ...McpServerCommonShape,
  }),
  z.strictObject({
    transport: z.literal("sse"),
    url: z.url(),
    auth: ModelAuthSchema.default({ type: "none" }),
    ...McpServerCommonShape,
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z.strictObject({
  servers: z.record(z.string(), McpServerConfigSchema).prefault({}),
  /** For every server without its own (or its profile's) value. */
  defaults: z
    .strictObject({ rateLimit: z.strictObject({ rpm: z.int().nonnegative() }).optional() })
    .prefault({}),
});

/* ------------------------------------------------------------------------------------------------
 * Project-level sections (ADR-0003, ADR-0009, ADR-0010, ADR-0013, ADR-0018)
 * ---------------------------------------------------------------------------------------------- */

export const ToolsConfigSchema = z.strictObject({
  /** Project commands exposed as `project.<name>` capabilities (tests, typecheck, lint, …). */
  local: z.record(z.string(), z.string().min(1)).prefault({}),
  /**
   * The checks a project (or a service of a knowledge repository) must have a command for: `tests`
   * is met by any `test*` command of `tools.local`, `lint` by `lint*`, any other name by itself.
   * What is missing is said by `onboard`, `doctor` and the Services page; the rest is optional.
   * Pilot: every service without `typecheck` was listed as unfinished, a JavaScript one has none.
   */
  required: z.array(z.string().min(1)).default(["tests"]),
  /**
   * Builds the checks depend on: before `project.checks`, the `tools.local` command `run` when a changed
   * file matches `when` (globs), and then every `typecheck*` check, whatever its scope — its package
   * reads the built output (a monorepo's shared library in its publish folder). Pilot: the app was
   * typechecked against the library built by `setup` before the run's changes, and passed; the build
   * failed afterwards. «Try it» puts the same commands before the start.
   */
  rebuild: z
    .array(z.strictObject({ when: z.array(z.string().min(1)).min(1), run: z.string().min(1) }))
    .default([]),
  /**
   * Fixers (a linter's --fix, a formatter): the `tools.local` command `run` with the files matching
   * `when` appended, relative to its package (`cd <dir> && …`). It runs on each file an agent writes —
   * the formatting is fixed and what the fixer cannot fix comes back in the write's result — and on
   * every changed file before `project.checks`. Pilot: a round of implementation went to an import's
   * line breaks (object-curly-newline) the linter fixes by itself.
   */
  fix: z
    .array(z.strictObject({ when: z.array(z.string().min(1)).min(1), run: z.string().min(1) }))
    .default([]),
  /**
   * More checks for `project.checks`: the `tools.local` command `run`, as it is, when the run changed a
   * file matching `when` (a snapshot of the API config, a routes table). Pilot: a snapshot the change
   * should have updated was found by the review, a model, not by the project's own check.
   */
  checks: z
    .array(z.strictObject({ when: z.array(z.string().min(1)).min(1), run: z.string().min(1) }))
    .default([]),
  /** Expose `shell.run` for arbitrary commands inside the workspace. Off by default. */
  shell: z.boolean().default(false),
  /** Tool output returned to the agent is capped; the full (redacted) output is kept as a blob. */
  maxOutputBytes: z.int().positive().default(65_536),
  /** Timeout for project commands and shell. */
  commandTimeoutMs: z.int().positive().default(600_000),
});

/** ADR-0001 §16 — git hooks. `jarvis prepush` reads this; `jarvis hooks install` wires the script. */
export const HooksConfigSchema = z.strictObject({
  prePush: z
    .strictObject({
      /** `block` fails the push on a required violation, a failing check or a blocking finding. */
      mode: z.enum(["block", "advisory"]).default("block"),
      /** Run the deterministic standards check on the pushed range. */
      standards: z.boolean().default(true),
      /** Names from `tools.local` (typecheck, lint, test …) run in order before the review. */
      checks: z.array(z.string().min(1)).default([]),
      /**
       * Semantic review by the review agent: `auto` — only when the graph says something impacted was
       * left untouched, or a semantic/hybrid standard applies; `always`; `never`.
       */
      semanticReview: z.enum(["auto", "never", "always"]).default("auto"),
      /** Findings of this severity or worse block (in `block` mode). */
      blockOn: z.enum(["blocker", "major"]).default("blocker"),
      /** Skip the hook for these branch globs (e.g. `wip/**`). */
      skipBranches: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
});

export const WorkspaceConfigSchema = z.strictObject({
  mode: WorkspaceModeSchema.default("worktree"),
  /**
   * How a run's own checkout is made in worktree mode: `worktree` (git worktree, the default) or
   * `clone` — a `git clone --shared` with a `.git` directory of its own, the objects shared with the
   * repository, the run's branch pushed back to it on every commit. For builds whose tools read git
   * with a library that does not know worktrees (JGit: a Gradle versioning plugin failed with
   * `Missing unknown <sha>` in every worktree).
   */
  checkout: z.enum(["worktree", "clone"]).default("worktree"),
  setup: z.string().min(1).optional(),
  /**
   * How a person tries the result before accepting it (the implementation gate's «Try it»): the commands
   * that start the project in the run's checkout (after `setup`, which already ran there), the address
   * to open, a line on what to look at. Without `run` the page guesses from package.json scripts.
   */
  try: z
    .strictObject({
      run: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
      url: z.string().min(1).optional(),
      note: z.string().min(1).optional(),
    })
    .optional(),
  /** Defaults to true in worktree mode and false in cwd mode (ADR-0003 §5). */
  allowWrites: z.boolean().optional(),
  /** Worktrees of terminal runs older than this are removed by `jarvis gc` (ADR-0003 §6). */
  retentionDays: z.int().positive().default(7),
  /**
   * Dependencies kept between worktrees (src/orchestration/depsCache.ts): `paths` are copied out after
   * a setup and back into the next worktree whose `key` files (lockfiles) have the same content.
   */
  cache: z
    .strictObject({
      key: z.array(z.string().min(1)).min(1),
      paths: z.array(z.string().min(1)).min(1),
    })
    .optional(),
});

const BudgetCapSchema = z.strictObject({
  outputTokens: z.int().positive().optional(),
  /** Prompt tokens sent: the real cost when every call re-sends the conversation (no prefix cache). */
  inputTokens: z.int().positive().optional(),
  requests: z.int().positive().optional(),
});

/**
 * A model that keeps failing (network errors, 5xx, timeouts after the gateway's own retries) parks
 * the run instead of failing it: checked again every `checkEveryMinutes`, given up after
 * `giveUpAfterHours` of unavailability (the run fails as before).
 */
export const ModelWaitSchema = z.strictObject({
  checkEveryMinutes: z.number().positive().default(5),
  giveUpAfterHours: z.number().positive().default(12),
});
export type ModelWait = z.infer<typeof ModelWaitSchema>;

export const BudgetConfigSchema = z.strictObject({
  perRun: BudgetCapSchema.prefault({}),
  perStep: BudgetCapSchema.prefault({}),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

const ratio = z.number().min(0).max(1);

export const ThresholdsSchema = z.strictObject({
  watch: ratio.optional(),
  compact: ratio.optional(),
  aggressive: ratio.optional(),
  reset: ratio.optional(),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const ContextConfigSchema = z.strictObject({
  thresholds: z
    .strictObject({
      default: ThresholdsSchema.prefault({}),
      byModel: z.record(z.string(), ThresholdsSchema).prefault({}),
      byPhase: z.record(z.string(), ThresholdsSchema).prefault({}),
    })
    .prefault({}),
  compactTarget: ratio.default(0.35),
  maxContext: z.int().positive().optional(),
  /**
   * Tool results an agent keeps in full, in tokens past its task message: over it, the oldest go to
   * pointers (the original stays readable) down to 60% of it, in one batch — whatever the window.
   * Pilot: with a 500k window nothing was trimmed before 178k tokens, and each of 151 calls of the test
   * agent sent its whole history again. 0 — off. Without it: 160k for a model whose gateway caches
   * prefixes (`models.<id>.prefixCache` — keeping costs little, a trim costs the reads it brings back:
   * 20 re-reads after three trims in a pilot research), else 80k.
   */
  workingSet: z.int().nonnegative().optional(),
});

/**
 * Documentation the team already keeps in the repository, read in place (no copies in `.jarvis/`):
 * markdown under `path` becomes knowledge, files matching `skills` become skills, `scopes` ties a
 * part of the documentation to the code paths it is about. A bare string is `{ path }`.
 */
export const KnowledgeSourceSchema = z.preprocess(
  (v) => (typeof v === "string" ? { path: v } : v),
  z.strictObject({
    /** Repository-relative directory or file. */
    path: z.string().min(1),
    /** Globs relative to `path`; a file source ignores them. */
    include: z.array(z.string().min(1)).default(["**/*.md"]),
    exclude: z.array(z.string().min(1)).default([]),
    /** Globs (relative to `path`, or a file name) of documents that are skills, e.g. `SKILL_*.md`. */
    skills: z.array(z.string().min(1)).default([]),
    /** Glob of documents (relative to `path`) → code paths they apply to; unmatched documents apply everywhere. */
    scopes: z.record(z.string(), z.array(z.string().min(1))).prefault({}),
    /** Agents the skills of this source are for; empty = implementation (ADR-0020 §1). */
    agents: z.array(z.string().min(1)).default([]),
  }),
);
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

/** ADR-0015 §2 v0.4: which source files the full-text index takes, and how much of them. */
export const CodeIndexSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Globs from the repository root; empty = every tracked source file. */
  include: z.array(z.string().min(1)).default([]),
  /** Globs left out on top of vendored, generated and denied paths. */
  exclude: z.array(z.string().min(1)).default([]),
  /** Files at most; the rest are reported as skipped (a monorepo does not fill the database). */
  maxFiles: z.int().positive().default(5000),
  /** A larger file is generated or data more often than code: skipped. */
  maxFileBytes: z
    .int()
    .positive()
    .default(256 * 1024),
});
export type CodeIndexConfig = z.infer<typeof CodeIndexSchema>;

/** ADR-0020 §3, §5 — how standards, skills and knowledge are selected and budgeted. */
export const KnowledgeConfigSchema = z.strictObject({
  /** Documentation read in place (see KnowledgeSourceSchema); `AGENTS.md` below the root is scoped to its directory. */
  sources: z.array(KnowledgeSourceSchema).default([]),
  /** Skills per agent call; the rest are listed as available on request. */
  maxSkills: z.int().positive().default(2),
  /** ADR-0015: how knowledge documents are chosen when more match than fit. */
  retrieval: z
    .strictObject({
      /** Use the index to rank knowledge docs once more than this many match the scope. */
      rankAbove: z.int().nonnegative().default(4),
      /** Model id (from `models`) with an OpenAI-compatible /embeddings endpoint; off by default (§6 gate). */
      embeddings: z.string().min(1).optional(),
      /** ADR-0015 §2 v0.4: tracked source files in the index as symbol units; `false` leaves code to repo.search. */
      code: z
        .union([z.boolean().transform((enabled) => CodeIndexSchema.parse({ enabled })), CodeIndexSchema])
        .prefault(true),
    })
    .prefault({}),
  /** Share of the context budget for L4 split among skills / standards / knowledge. */
  split: z
    .strictObject({
      skills: ratio.default(0.4),
      standards: ratio.default(0.35),
      knowledge: ratio.default(0.25),
    })
    .prefault({}),
});
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>;

/** ADR-0019 §9 — how and when humans take part. Narrow-only along the precedence chain. */
export const HumanConfigSchema = z.strictObject({
  /** Keyed by the artifact type an approval step gates: `required: false` passes the gate silently. */
  gates: z.record(z.string(), z.strictObject({ required: z.boolean().default(true) })).prefault({}),
  review: z
    .strictObject({
      sourceMarkers: z.boolean().default(true),
      removeMarkersAfterApproval: z.boolean().default(true),
    })
    .prefault({}),
  clarification: z
    .strictObject({
      multiTurn: z.boolean().default(true),
      maxTurns: z.int().positive().default(8),
    })
    .prefault({}),
  /** Before a gate: answers to the document's open questions from what the run collected (one model call). */
  suggestAnswers: z.boolean().default(true),
  /**
   * When failed checks stop the run for a person instead of the next round (src/app/rounds.ts):
   * `same-failure` — the round failed as the one before, or no test ran; `every-failure`;
   * `when-rounds-end` — only when the back edge's rounds are used up.
   */
  checks: z
    .strictObject({
      ask: z.enum(["same-failure", "every-failure", "when-rounds-end"]).default("same-failure"),
    })
    .prefault({}),
  /**
   * Runs go without a person by default (src/app/autonomy.ts; experimental): gates pass, a question gets
   * the most cautious assumption, a dead end ends the run. `--autonomous` asks it for one run.
   */
  autonomous: z.boolean().default(false),
});
export type HumanConfig = z.infer<typeof HumanConfigSchema>;

/**
 * ADR-0016 §6: one MCP server allowed out of the network its project's data class keeps it in — for
 * reads only, with the reason. Only in `.jarvis/project.yaml` (a team's decision, seen in review); every
 * run says so at its start and the page shows it.
 */
export const EgressExceptionSchema = z.strictObject({
  server: z.string().min(1),
  /** Which of its capabilities (patterns); all its reads when absent. */
  capabilities: z.array(z.string().min(1)).default(["*"]),
  reason: z.string().min(10),
});
export type EgressException = z.infer<typeof EgressExceptionSchema>;

/**
 * ADR-0016 §6: one model with `egress: cloud` allowed for a project whose data class keeps models
 * private — the team's decision with its reason, only in project.yaml; every run says so at its start.
 */
export const ModelEgressExceptionSchema = z.strictObject({
  model: z.string().min(1),
  reason: z.string().min(10),
});
export type ModelEgressException = z.infer<typeof ModelEgressExceptionSchema>;

export const SecurityConfigSchema = z.strictObject({
  secretPatterns: z.array(z.strictObject({ name: z.string().min(1), regex: z.string().min(1) })).default([]),
  secretEnv: z.array(z.string().min(1)).default([]),
  deniedPaths: z.array(z.string().min(1)).default([]),
});

export const TelemetryConfigSchema = z.strictObject({
  export: z
    .strictObject({
      enabled: z.boolean().default(false),
      url: z.url().optional(),
      network: NetworkSchema.default("intranet"),
      payloads: z.boolean().default(false),
      maxPayloadBytes: z.int().positive().default(4096),
    })
    .prefault({}),
});

/**
 * Per-agent settings (`agents.<agentId>`): the step limits of a built-in agent for this project or
 * machine. Pilot: 40 tool calls of the research agent ran out on a large monorepo with nothing to
 * raise them but a code change.
 */
export const AgentConfigSchema = z.strictObject({
  limits: z
    .strictObject({
      maxToolCalls: z.int().positive().optional(),
      maxModelCalls: z.int().positive().optional(),
    })
    .optional(),
  /**
   * When the agent uses up its tool or model calls: `finish` — the result from what it has, marked
   * incomplete; `ask` — the run waits for a person to grant more or let it finish. Over the step's own.
   */
  onLimit: z.enum(["finish", "ask"]).optional(),
  /**
   * `reasoning_effort` of this agent's calls, over the model's own: sent to a model with
   * `supports.reasoning` or a `reasoningEffort` of its own (others may refuse the field).
   */
  reasoningEffort: ReasoningEffortSchema.optional(),
  /** The task message's size in characters (inputs and knowledge), over the agent's own `baseChars`. */
  baseChars: z.int().positive().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * ADR-0003 §4: a finished run delivered as a pull request — a push of its branch and the PR through
 * the MCP server's `*.pr.create`. `pr`: `allow` — as asked; `approve` — a person approves the PR's
 * title and description first; `deny` — no PR from this project (Apply stays).
 */
export const DeliveryConfigSchema = z.strictObject({
  pr: z.enum(["allow", "approve", "deny"]).default("allow"),
  /** The remote the branch is pushed to. */
  remote: z.string().min(1).default("origin"),
  /** The branch the PR goes into; unset — the remote's default branch, else `main`. */
  target: z.string().min(1).optional(),
  /** The capability that opens the PR when several servers have one (`bitbucket.pr.create`). */
  capability: z.string().min(1).optional(),
  /** The repository on the server: `workspace` (project key) and `repo`; unset — from the remote's URL. */
  workspace: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  /**
   * The branch the PR is pushed as, by the team's rule: `{key}` the task's issue key, `{slug}` its
   * title in a few words, `{run}` the run's short id (`feature/{key}`, `feature/{key}_{slug}`); unset —
   * the run's own `jarvis/…` branch.
   */
  branch: z.string().min(1).optional(),
  /** The PR's commit message by the team's standard (Conventional Commits with the issue key, say). */
  commit: z
    .strictObject({
      /** `{type}`, `{scope}`, `{key}`, `{subject}`: `"{type}({scope}): {key} {subject}"`; an empty scope drops its parentheses. */
      format: z.string().min(1).default("{subject}"),
      /** The run's kind of task → `{type}`. */
      types: z.record(z.string().min(1), z.string().min(1)).default({
        feature: "feat",
        change: "feat",
        fix: "fix",
        refactor: "refactor",
        test: "test",
        docs: "docs",
      }),
      /** `{scope}`: `auto` — the module or service most of the change is in; `none` — empty; else that text. */
      scope: z.string().min(1).default("auto"),
      /** A commit made for a PR comment. */
      fix: z.string().min(1).default("{subject}"),
    })
    .prefault({}),
  /** The PR's title; the same keys as `commit.format`. */
  prTitle: z.string().min(1).default("{subject}"),
  /**
   * Trailers that say Jarvis made it: `Jarvis-Run` (always — `jarvis explain` follows it) and
   * `Assisted-By` (`{version}` is Jarvis's), false — none.
   */
  assistedBy: z.union([z.literal(false), z.string().min(1)]).default("Jarvis {version}"),
  /**
   * The repository's git hooks (husky, lint-staged, commitlint) run on Jarvis's work as on a person's:
   * pre-commit and pre-push with the project's checks (a failure goes back to the implementation),
   * commit-msg as a warning there; the PR's commit and Apply are real commits through the hooks.
   */
  hooks: z.boolean().default(true),
  /**
   * The PR flow: a run that changed code puts up its PR itself once its work is approved, then follows
   * the PR's comments until it is ready for merge (the merge is always a person's). `enabled` is the
   * default for runs; a run may say otherwise (`--pr-flow` / `--no-pr-flow`, New task).
   */
  flow: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** How often the PR's comments are read while the session is on, minutes. */
      pollMinutes: z.int().min(1).max(120).default(5),
      /** The agent agrees with a comment: it fixes and pushes; false — it asks first. */
      fixWhenAgreed: z.boolean().default(true),
      /** Ready for merge: this many approvals (the front 2, the back 1 — per repository or service). */
      ready: z.strictObject({ approvals: z.int().min(0).max(10).default(1) }).prefault({}),
    })
    .prefault({}),
});
export type DeliveryConfig = z.infer<typeof DeliveryConfigSchema>;

/**
 * ADR-0006 §4: the daemon resumes runs as `service:daemon`; it uses the owner's credentials for an
 * effect (a push, a PR) only with `actAsOwner` — on the owner's own machine, the default.
 */
/**
 * ADR-0026: the work of related tasks — their branches and PRs — read before the spec. `enabled` is the
 * project's default; a run may say otherwise (`--related` / `--no-related`, New task).
 */
export const RelatedWorkConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** How many related tasks are read, at most (an epic of a dozen tasks is the usual case). */
  maxIssues: z.int().positive().max(30).default(12),
  /** The Jira issue type → the side of the work, to read the other side first ("Back Task" and "Middle Task": back). */
  sides: z
    .record(z.string().min(1), z.string().min(1))
    .default({ "Back Task": "back", "Middle Task": "back", "Front Task": "front" }),
  /**
   * A prefix in the task's title → its side, for types that do not say it ("Change": "[Java] …",
   * "[Front] …"); in any case. The type's side (`sides`) goes first.
   */
  prefixes: z
    .record(z.string().min(1), z.string().min(1))
    .default({ java: "back", back: "back", middle: "back", js: "front", front: "front" }),
  /** What a branch is compared with; default — the repository's default branch. */
  base: z.string().min(1).optional(),
  /**
   * Stories between an epic and its tasks: a Story includes tasks (an issue link), has its own branch
   * in each repository it touches (the same name in all), the tasks branch off it and their PRs go
   * into it, and the Story's PR goes into the base once tested. A task with no such link works as before.
   */
  story: z
    .strictObject({
      /** The issue types that are Stories. */
      types: z.array(z.string().min(1)).default(["Story"]),
      /** The link's name from the Story's side ("includes"). */
      includes: z.array(z.string().min(1)).default(["Включает в себя", "includes"]),
      /** The link's name from the task's side ("is included in"). */
      includedIn: z.array(z.string().min(1)).default(["Включена в", "is included in"]),
      /** The Story's branch, `{key}` its issue key: the same in every repository. */
      branch: z.string().min(1).default("feature/{key}"),
      /** The run of a task in a Story starts from the Story's branch and its PR goes into it, when the repository has the branch. */
      base: z.boolean().default(true),
      /**
       * The repository has no branch for the Story yet (the Story's first task here): Jarvis makes it
       * from the base (`delivery.target`, else `relatedWork.base`, else the remote's default) and pushes
       * it, then starts the run from it.
       */
      create: z.boolean().default(true),
    })
    .prefault({}),
});

/**
 * «Report a problem» in `jarvis ui`: the GitHub repository whose new-issue form it opens, filled in.
 * `repo: false` hides it; `host` is a GitHub Enterprise address.
 */
export const FeedbackConfigSchema = z.strictObject({
  repo: z
    .union([z.literal(false), z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name")])
    .default("mxmvshnvsk/jarvis-harness"),
  host: z
    .string()
    .regex(/^https:\/\/[^\s/]+$/, "https://host, without a path")
    .default("https://github.com"),
});

export const DaemonConfigSchema = z.strictObject({
  actAsOwner: z.boolean().default(true),
});

export const ActorConfigSchema = z.strictObject({
  id: z.string().min(1).optional(),
  display: z.string().min(1).optional(),
});

/** ADR-0009 §1 — a profile may only narrow the base configuration. */
export const ProfileOverlaySchema = z.strictObject({
  interactive: z.boolean().optional(),
  dataClass: DataClassSchema.optional(),
  workspace: z
    .strictObject({ mode: WorkspaceModeSchema.optional(), allowWrites: z.boolean().optional() })
    .optional(),
  mcp: z.strictObject({ deny: z.array(z.string().min(1)).default([]) }).optional(),
  tools: z.strictObject({ deny: z.array(z.string().min(1)).default([]) }).optional(),
  humanGate: HumanGateModeSchema.optional(),
  budget: BudgetConfigSchema.optional(),
});
export type ProfileOverlay = z.infer<typeof ProfileOverlaySchema>;

/* ------------------------------------------------------------------------------------------------
 * Files
 * ---------------------------------------------------------------------------------------------- */

export const CONFIG_VERSION = 1 as const;

/**
 * The language agents write in for people: documents, answers, comments (`ru`, `en`, …, or a name). Keys,
 * code, paths and quotes stay as they are. Unset — the models' own choice (in practice English).
 */
export const LanguageSchema = z.string().min(2).max(40);

/** A task across services (ADR-0025 §6): how many of its subtasks run at once (the models' quota is shared). */
export const CrossReposSchema = z.strictObject({
  maxParallel: z.int().positive().default(2),
});

/** `24h`, `90m`, `7d`: how often a scheduled eval suite runs. */
export const EVERY = /^(\d+)(m|h|d)$/;

/**
 * A suite the daemon runs on a schedule (ADR-0012 §5): live, on its own quota pool only, so it never
 * spends the team's interactive quota; the result is compared with the suite's baseline.
 */
export const EvalScheduleSchema = z
  .strictObject({
    suite: z.string().min(1).default("default"),
    /** How often: `24h`, `90m`, `7d`. Or `cron`. */
    every: z.string().regex(EVERY, "a period like 24h, 90m or 7d").optional(),
    /** Five fields, the machine's local time: `30 3 * * *` (03:30 every day), `0 4 * * 1-5`. */
    cron: z.string().min(1).optional(),
    mode: z.enum(["live", "record", "replay"]).default("live"),
    /** The quota pool (`quotaPools`) its models must be in; models of other pools are not used. */
    pool: z.string().min(1),
    /** Allowed drop against the baseline, as `jarvis evals diff --tolerance`. */
    tolerance: z.number().min(0).max(1).default(0.05),
  })
  .refine((s) => (s.every === undefined) !== (s.cron === undefined), {
    message: "a schedule needs either every or cron",
  });
export type EvalSchedule = z.infer<typeof EvalScheduleSchema>;

export const EvalsConfigSchema = z.strictObject({
  schedule: z.union([EvalScheduleSchema, z.array(EvalScheduleSchema)]).optional(),
});

/** A service's name in a knowledge repository: its folder by default (ADR-0025 §2). */
export const ServiceNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "a service name: letters, digits, `.`, `_`, `-`");

/** `~/.jarvis/config.yaml` — the machine and the person (ADR-0017 §1). */
export const UserConfigSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  actor: ActorConfigSchema.optional(),
  quotaPools: z.record(z.string(), QuotaPoolSchema).optional(),
  models: z.record(z.string(), ModelConfigSchema).optional(),
  roles: z.record(z.string(), RoleConfigSchema).optional(),
  mcp: McpConfigSchema.optional(),
  context: ContextConfigSchema.optional(),
  telemetry: TelemetryConfigSchema.optional(),
  agents: z.record(z.string(), AgentConfigSchema).optional(),
  modelWait: ModelWaitSchema.optional(),
  language: LanguageSchema.optional(),
  /** The knowledge repository (ADR-0025 §3) when it is not next to the repositories; `~` allowed. */
  knowledgeRepo: z.string().min(1).optional(),
  /** This machine's repositories laid out differently: service → path (over the knowledge repository's map). */
  repos: z.record(ServiceNameSchema, z.string().min(1)).optional(),
  /** Scheduled eval suites this machine's daemon runs (ADR-0012 §5). */
  evals: EvalsConfigSchema.optional(),
  daemon: DaemonConfigSchema.optional(),
  feedback: FeedbackConfigSchema.optional(),
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

/**
 * A map of the project's API contracts the design step checks the task's `METHOD /path` against
 * (src/design/contracts.ts): JSON, an object of key → { path, url, method? } or an array of them.
 */
export const ContractMapSchema = z.strictObject({
  files: z.array(z.string().min(1)).min(1),
  about: z.string().min(1).optional(),
});

/** `.jarvis/project.yaml` — the project and the team (ADR-0017 §1). */
const ProjectFieldsSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  dataClass: DataClassSchema.optional(),
  roles: z.record(z.string(), RoleConfigSchema).optional(),
  mcp: McpConfigSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  workspace: WorkspaceConfigSchema.optional(),
  budget: BudgetConfigSchema.optional(),
  profiles: z.record(z.string(), ProfileOverlaySchema).optional(),
  context: ContextConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
  egressExceptions: z.array(EgressExceptionSchema).optional(),
  modelEgressExceptions: z.array(ModelEgressExceptionSchema).optional(),
  humanGate: HumanGateModeSchema.optional(),
  knowledge: KnowledgeConfigSchema.optional(),
  human: HumanConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  modelWait: ModelWaitSchema.optional(),
  agents: z.record(z.string(), AgentConfigSchema).optional(),
  /** Stack tags (ADR-0021 §3): typescript, react, csharp, … Empty = detected from the workspace. */
  stack: z.array(z.string().min(1)).optional(),
  /** ADR-0021 §9 polyglot: path glob → stacks, e.g. "backend/**": [csharp, aspnet]. */
  stackScopes: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
  /** The team's language for what agents write (project over user). */
  language: LanguageSchema.optional(),
  /** Contract maps the task's API methods are checked against before the agents (design step). */
  contracts: z.array(ContractMapSchema).optional(),
  crossRepos: CrossReposSchema.optional(),
  /** Scheduled eval suites (ADR-0012 §5); the pool named must be in the machine's `quotaPools`. */
  evals: EvalsConfigSchema.optional(),
  /** How a finished run may go out as a pull request (ADR-0003 §4). */
  delivery: DeliveryConfigSchema.optional(),
  /** Where «Report a problem» opens an issue (a fork's own repository). */
  feedback: FeedbackConfigSchema.optional(),
  /** The work of related tasks read before the spec (ADR-0026). */
  relatedWork: RelatedWorkConfigSchema.optional(),
});

/**
 * `services.<name>` of a knowledge repository's project.yaml: the same keys as the project's, over
 * the shared ones, and where its repository is when the folder is named differently.
 */
export const ServiceConfigSchema = ProjectFieldsSchema.omit({
  version: true,
  evals: true,
  feedback: true,
}).extend({
  /** Its repository: a folder under `repos`, or a path (relative to `repos`); default — the name. */
  repo: z.string().min(1).optional(),
  /** The path segment the balancer routes to it (`http://${SERVICE_HOST}/<path>`), when not its name. */
  path: z.string().min(1).optional(),
  /**
   * What it is, as `jarvis onboard` found it (src/onboarding/serviceEntry.ts). `library`: in a task across
   * services it changes first — the services that use it start once its change is accepted and published
   * (`tools.local.publish-local`); backend and frontend are said, not acted on.
   */
  kind: z.enum(["backend", "frontend", "library"]).optional(),
  /** A library: the names the services depend on it by (`com.example:common-lib`, `@acme/ui-kit`). */
  publishes: z.array(z.string().min(1)).optional(),
  /** The libraries of the map this service depends on: it waits for their change in a task across services. */
  uses: z.array(ServiceNameSchema).optional(),
});
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;

export const ProjectConfigSchema = ProjectFieldsSchema.extend({
  /** A knowledge repository (ADR-0025): where the services' repositories are, relative to it. Default `..`. */
  repos: z.string().min(1).optional(),
  /** A knowledge repository: its services, each over the shared configuration above. */
  services: z.record(ServiceNameSchema, ServiceConfigSchema).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** The merged, validated configuration every subsystem reads. */
export const ResolvedConfigSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  dataClass: DataClassSchema.default("confidential"),
  interactive: z.boolean().default(true),
  humanGate: HumanGateModeSchema.default("artifact"),
  actor: ActorConfigSchema.prefault({}),
  quotaPools: z.record(z.string(), QuotaPoolSchema).prefault({}),
  models: z.record(z.string(), ModelConfigSchema).prefault({}),
  roles: z.record(z.string(), RoleConfigSchema).prefault({}),
  mcp: McpConfigSchema.prefault({}),
  tools: ToolsConfigSchema.prefault({}),
  workspace: WorkspaceConfigSchema.prefault({}),
  budget: BudgetConfigSchema.prefault({}),
  profiles: z.record(z.string(), ProfileOverlaySchema).prefault({}),
  context: ContextConfigSchema.prefault({}),
  security: SecurityConfigSchema.prefault({}),
  egressExceptions: z.array(EgressExceptionSchema).default([]),
  modelEgressExceptions: z.array(ModelEgressExceptionSchema).default([]),
  telemetry: TelemetryConfigSchema.prefault({}),
  knowledge: KnowledgeConfigSchema.prefault({}),
  human: HumanConfigSchema.prefault({}),
  hooks: HooksConfigSchema.prefault({}),
  agents: z.record(z.string(), AgentConfigSchema).prefault({}),
  modelWait: ModelWaitSchema.prefault({}),
  stack: z.array(z.string().min(1)).default([]),
  stackScopes: z.record(z.string().min(1), z.array(z.string().min(1))).prefault({}),
  language: LanguageSchema.optional(),
  contracts: z.array(ContractMapSchema).default([]),
  crossRepos: CrossReposSchema.prefault({}),
  evals: EvalsConfigSchema.prefault({}),
  delivery: DeliveryConfigSchema.prefault({}),
  daemon: DaemonConfigSchema.prefault({}),
  feedback: FeedbackConfigSchema.prefault({}),
  relatedWork: RelatedWorkConfigSchema.prefault({}),
  /** Capability patterns denied by the active profile (ADR-0009 §1); applied by the Tool Router. */
  deniedCapabilities: z.array(z.string().min(1)).default([]),
  /** Name of the applied profile, if any. */
  profile: z.string().min(1).optional(),
});
export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;
