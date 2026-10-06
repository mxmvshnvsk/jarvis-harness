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
  maxOutput: z.int().positive(),
  supports: ModelSupportsSchema.prefault({}),
  tokenizer: z.string().min(1).optional(),
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

export const QuotaPoolSchema = z.strictObject({
  window: QuotaWindowSchema,
  limits: QuotaLimitsSchema.prefault({}),
  soft: z.number().min(0).max(1).default(0.8),
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
});

/* ------------------------------------------------------------------------------------------------
 * Project-level sections (ADR-0003, ADR-0009, ADR-0010, ADR-0013, ADR-0018)
 * ---------------------------------------------------------------------------------------------- */

export const ToolsConfigSchema = z.strictObject({
  /** Project commands exposed as `project.<name>` capabilities (tests, typecheck, lint, …). */
  local: z.record(z.string(), z.string().min(1)).prefault({}),
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
  setup: z.string().min(1).optional(),
  /** Defaults to true in worktree mode and false in cwd mode (ADR-0003 §5). */
  allowWrites: z.boolean().optional(),
  /** Worktrees of terminal runs older than this are removed by `jarvis gc` (ADR-0003 §6). */
  retentionDays: z.int().positive().default(7),
});

const BudgetCapSchema = z.strictObject({
  outputTokens: z.int().positive().optional(),
  requests: z.int().positive().optional(),
});

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
  mode: z.enum(["autonomous", "balanced", "strict"]).default("balanced"),
  /** Keyed by the artifact type an approval step gates: `required: false` passes the gate silently. */
  gates: z.record(z.string(), z.strictObject({ required: z.boolean().default(true) })).prefault({}),
  review: z
    .strictObject({
      sourceMarkers: z.boolean().default(true),
      removeMarkersAfterApproval: z.boolean().default(true),
      knowledgePromotion: z.enum(["confirm", "never"]).default("confirm"),
    })
    .prefault({}),
  clarification: z
    .strictObject({
      multiTurn: z.boolean().default(true),
      maxTurns: z.int().positive().default(8),
    })
    .prefault({}),
  manualEdits: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
});
export type HumanConfig = z.infer<typeof HumanConfigSchema>;

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
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

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
});
export type UserConfig = z.infer<typeof UserConfigSchema>;

/** `.jarvis/project.yaml` — the project and the team (ADR-0017 §1). */
export const ProjectConfigSchema = z.strictObject({
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
  humanGate: HumanGateModeSchema.optional(),
  knowledge: KnowledgeConfigSchema.optional(),
  human: HumanConfigSchema.optional(),
  hooks: HooksConfigSchema.optional(),
  agents: z.record(z.string(), AgentConfigSchema).optional(),
  /** Stack tags (ADR-0021 §3): typescript, react, csharp, … Empty = detected from the workspace. */
  stack: z.array(z.string().min(1)).optional(),
  /** ADR-0021 §9 polyglot: path glob → stacks, e.g. "backend/**": [csharp, aspnet]. */
  stackScopes: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
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
  telemetry: TelemetryConfigSchema.prefault({}),
  knowledge: KnowledgeConfigSchema.prefault({}),
  human: HumanConfigSchema.prefault({}),
  hooks: HooksConfigSchema.prefault({}),
  agents: z.record(z.string(), AgentConfigSchema).prefault({}),
  stack: z.array(z.string().min(1)).default([]),
  stackScopes: z.record(z.string().min(1), z.array(z.string().min(1))).prefault({}),
  /** Capability patterns denied by the active profile (ADR-0009 §1); applied by the Tool Router. */
  deniedCapabilities: z.array(z.string().min(1)).default([]),
  /** Name of the applied profile, if any. */
  profile: z.string().min(1).optional(),
});
export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;
