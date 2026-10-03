import { DeterministicExecutor } from "../orchestration/executors.ts";
import { LocalWorkflowEngine } from "../orchestration/runtime.ts";
import { BUILTIN_TOOLS } from "../orchestration/tools/builtin.ts";
import type { StepExecutor } from "../orchestration/types.ts";
import { loadWorkflows } from "../workflows/load.ts";
import type { Runtime } from "./runtime.ts";

/** The engine as the CLI and the daemon use it: built-in workflows plus the project's own. */
export function createEngine(
  runtime: Runtime,
  executors: Partial<Record<StepExecutor["kind"], StepExecutor>> = {},
): LocalWorkflowEngine {
  return new LocalWorkflowEngine({
    runtime,
    workflows: loadWorkflows(runtime.loaded.project?.root),
    executors: { deterministic: new DeterministicExecutor(BUILTIN_TOOLS), ...executors },
  });
}
