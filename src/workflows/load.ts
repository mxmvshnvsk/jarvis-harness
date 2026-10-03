import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ConfigError, zodIssues } from "../core/config/errors.ts";
import { type WorkflowDefinition, WorkflowDefinitionSchema } from "../core/domain/workflow.ts";
import { BUILTIN_WORKFLOWS } from "./builtin.ts";

export function parseWorkflow(text: string, source: string): WorkflowDefinition {
  const raw: unknown = YAML.parse(text);
  const result = WorkflowDefinitionSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `invalid workflow definition (${source})`,
      zodIssues(result.error).map((i) => ({ ...i, source })),
    );
  }
  return result.data;
}

/** Built-in workflows, overridden by `<project>/.jarvis/workflows/*.yaml` with the same name. */
export function loadWorkflows(projectRoot?: string): Map<string, WorkflowDefinition> {
  const map = new Map<string, WorkflowDefinition>();
  for (const [name, text] of Object.entries(BUILTIN_WORKFLOWS))
    map.set(name, parseWorkflow(text, `builtin:${name}`));
  if (projectRoot) {
    const dir = join(projectRoot, ".jarvis", "workflows");
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .sort()) {
        const path = join(dir, file);
        const wf = parseWorkflow(readFileSync(path, "utf8"), path);
        map.set(wf.name, wf);
      }
    }
  }
  return map;
}
