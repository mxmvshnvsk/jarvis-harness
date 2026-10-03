import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolContext } from "../types.ts";

export class PathDeniedError extends Error {
  constructor(path: string, reason: string) {
    super(`path "${path}" denied: ${reason}`);
    this.name = "PathDeniedError";
  }
}

/**
 * Resolves a path inside the workspace (ADR-0001 §13 "repo patch ограничивается workspace",
 * ADR-0010 §2 denied paths). Symlinks are resolved so a link cannot escape the workspace.
 */
export function resolveInWorkspace(ctx: ToolContext, input: string): { absolute: string; relative: string } {
  const root = realpathSync(ctx.workspacePath);
  const candidate = isAbsolute(input) ? input : resolve(root, input);
  // Resolve the deepest existing ancestor so new files are checked by their parent directory.
  let probe = candidate;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const real = realpathSync(probe);
  const resolved = real + candidate.slice(probe.length);
  const rel = relative(root, resolved);
  if (rel === "" || rel === ".") return { absolute: root, relative: "." };
  if (rel.startsWith("..") || isAbsolute(rel)) throw new PathDeniedError(input, "outside the workspace");
  const normalized = rel.split(sep).join("/");
  if (ctx.pathPolicy.isDenied(normalized)) {
    ctx.runtime.events.emit({
      kind: "security.pathDenied",
      runId: ctx.run.id,
      stepId: ctx.stepId,
      payload: { path: normalized },
    });
    throw new PathDeniedError(input, "secret location (security.deniedPaths)");
  }
  return { absolute: resolved, relative: normalized };
}
