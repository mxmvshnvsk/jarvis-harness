import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "../app/runtime.ts";
import { homePath } from "../cli/checkout.ts";
import type { Run } from "../core/domain/run.ts";
import { STEP_DONE, type WorkflowDefinition } from "../core/domain/workflow.ts";
import { shortRunId } from "../storage/runStore.ts";

/**
 * How a person tries the result of a run before accepting it — the implementation gate's «Try it».
 * Pilot: the run stood at the last gate with 37 files changed, and the question was «where do I check
 * out to start the project?» — the checkout, its setup and the start command were nowhere on the page.
 * Everything here is deterministic: the run's checkout, `workspace.setup` (it already ran there: a failed
 * setup leaves no checkout), `workspace.try` from project.yaml, the spec's acceptance criteria, what
 * Accept and Send back lead to in the workflow.
 */
export interface TryOut {
  readonly checkout: string;
  /** `~/…` */
  readonly checkoutShown: string;
  readonly branch?: string;
  /** `base..branch`, short. */
  readonly range?: string;
  readonly setup?: string;
  /** The commands that start the project; `guessed` — from package.json, not from `workspace.try`. */
  readonly start: readonly string[];
  readonly guessed: boolean;
  readonly url?: string;
  readonly note?: string;
  /** The same in the main repository: a branch of one's own from the run's branch. */
  readonly inRepo?: {
    readonly repoRoot: string;
    readonly repoShown: string;
    readonly commands: readonly string[];
  };
  /** The spec's acceptance criteria, per requirement: what to check by hand. */
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly acceptance: readonly string[];
  }>;
  /** What Jarvis already ran: the last tests verdict. */
  readonly verified?: {
    readonly passed: boolean;
    readonly commands: readonly string[];
    readonly failures: number;
  };
  readonly onAccept?: string;
  /** Lands the run's branch on one's own branch after Accept. */
  readonly apply: string;
  readonly onSendBack?: string;
}

const SCRIPTS = ["start-dev", "start:dev", "dev", "start", "serve"];

function packageManager(dir: string): string {
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  return "npm run";
}

/** The start command from package.json scripts, when the project did not say it. */
export function guessStart(dir: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const script = SCRIPTS.find((s) => typeof pkg.scripts?.[s] === "string");
    return script ? [`${packageManager(dir)} ${script}`] : [];
  } catch {
    return [];
  }
}

function json(runtime: Runtime, runId: string, type: string): Record<string, unknown> | undefined {
  const a = runtime.artifacts.listLatest(runId, type)[0];
  if (!a) return undefined;
  try {
    const v = JSON.parse(runtime.artifacts.text(a)) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function checksOf(spec: Record<string, unknown> | undefined): TryOut["checks"] {
  const reqs = Array.isArray(spec?.requirements) ? spec.requirements : [];
  return reqs.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const acceptance = Array.isArray(o.acceptance)
      ? o.acceptance.filter((x): x is string => typeof x === "string")
      : [];
    if (typeof o.text !== "string" || acceptance.length === 0) return [];
    return [{ id: typeof o.id === "string" ? o.id : "", text: o.text, acceptance }];
  });
}

const stepName = (to: string) => (to === STEP_DONE ? "the run completes" : to);

export function tryOutOf(
  runtime: Runtime,
  run: Run,
  options: { readonly workflow?: WorkflowDefinition; readonly homeDir?: string } = {},
): TryOut | undefined {
  const { workflow, homeDir = "" } = options;
  const ws = run.workspace;
  if (ws.mode !== "worktree" || !existsSync(ws.path)) return undefined;
  const config = runtime.loaded.config.workspace;
  const declared = config.try?.run;
  const start = declared ? (typeof declared === "string" ? [declared] : [...declared]) : guessStart(ws.path);
  const setup = config.setup;
  const short = shortRunId(run.id);
  const inRepo =
    ws.branch && ws.repoRoot !== ws.path
      ? {
          repoRoot: ws.repoRoot,
          repoShown: homePath(ws.repoRoot, homeDir),
          commands: [`git switch -c try-${short} ${ws.branch}`, ...(setup ? [setup] : []), ...start],
        }
      : undefined;
  const tests = json(runtime, run.id, "tests");
  // the gate the run stands at, else the workflow's implementation gate
  const gate =
    workflow?.steps.find((s) => s.kind === "approval" && s.id === run.currentStep) ??
    workflow?.steps.find((s) => s.kind === "approval" && s.artifactType === "implementation");
  const back = gate?.transitions.onOutcome.request_changes?.to;
  const next = gate?.transitions.onSuccess;
  return {
    checkout: ws.path,
    checkoutShown: homePath(ws.path, homeDir),
    ...(ws.branch ? { branch: ws.branch } : {}),
    ...(ws.branch && ws.baseCommit ? { range: `${ws.baseCommit.slice(0, 8)}..${ws.branch}` } : {}),
    ...(setup ? { setup } : {}),
    start,
    guessed: !declared,
    ...(config.try?.url ? { url: config.try.url } : {}),
    ...(config.try?.note ? { note: config.try.note } : {}),
    ...(inRepo ? { inRepo } : {}),
    apply: `jarvis apply ${short}`,
    checks: checksOf(json(runtime, run.id, "spec")),
    ...(tests && typeof tests.passed === "boolean"
      ? {
          verified: {
            passed: tests.passed,
            commands: Array.isArray(tests.commandsRun)
              ? tests.commandsRun.filter((c): c is string => typeof c === "string")
              : [],
            failures: Array.isArray(tests.failures) ? tests.failures.length : 0,
          },
        }
      : {}),
    ...(next
      ? {
          onAccept: next === STEP_DONE ? "the run completes" : `${stepName(next)}, then the run completes`,
        }
      : {}),
    ...(back
      ? {
          onSendBack: `${back} again with your comment and line comments, then the checks and this gate again`,
        }
      : {}),
  };
}

/** `cd` that a shell takes as is: `~` stays outside the quotes, quotes only when the path needs them. */
export function cdTo(path: string): string {
  const quote = (p: string) => (/^[\w./~-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, "\\$1")}"`);
  return path.startsWith("~/") ? `cd ~/${quote(path.slice(2))}` : `cd ${quote(path)}`;
}

/** One line to paste: into the checkout and start. */
export function tryCommand(t: TryOut): string {
  return [cdTo(t.checkoutShown), ...t.start].join(" && ");
}
