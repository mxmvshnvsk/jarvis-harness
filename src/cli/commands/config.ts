import { flattenLeaves, type LoadedConfig, loadConfig, SOURCE_DEFAULT } from "../../core/config/index.ts";
import type { CliContext } from "../context.ts";
import { formatValue, padEnd } from "../output.ts";

export interface ConfigShowOptions {
  readonly sources?: boolean;
}

export async function loadForCli(ctx: CliContext): Promise<LoadedConfig> {
  return loadConfig(
    ctx.profile === undefined
      ? { cwd: ctx.cwd, env: ctx.env, homeDir: ctx.homeDir }
      : { cwd: ctx.cwd, env: ctx.env, homeDir: ctx.homeDir, profile: ctx.profile },
  );
}

/** `jarvis config show [--sources]` (ADR-0014 §2). */
export async function runConfigShow(ctx: CliContext, options: ConfigShowOptions = {}): Promise<void> {
  const loaded = await loadForCli(ctx);
  const leaves = flattenLeaves(loaded.config).filter(([path]) => path !== "");
  ctx.out.result(
    { config: loaded.config, sources: loaded.sources, files: loaded.files, warnings: loaded.warnings },
    () => {
      ctx.out.line(
        `user config:    ${loaded.files.user.path}${loaded.files.user.exists ? "" : " (missing)"}`,
      );
      if (loaded.files.project) {
        ctx.out.line(
          `project config: ${loaded.files.project.path}${loaded.files.project.exists ? "" : " (missing)"}`,
        );
      }
      if (loaded.config.profile) ctx.out.line(`profile:        ${loaded.config.profile}`);
      ctx.out.line();
      const width = Math.min(60, Math.max(...leaves.map(([p]) => p.length)));
      for (const [path, value] of leaves) {
        const text = `${padEnd(path, width)} = ${formatValue(value)}`;
        if (options.sources) {
          const source = loaded.sources[path] ?? nearest(path, loaded.sources) ?? SOURCE_DEFAULT;
          ctx.out.line(`${text}  [${source}]`);
        } else {
          ctx.out.line(text);
        }
      }
      for (const warning of loaded.warnings) ctx.out.line(`\nwarning: ${warning}`);
    },
  );
}

function nearest(path: string, sources: Record<string, string>): string | undefined {
  let current = path;
  for (;;) {
    const trimmed = current.replace(/(\[[^\]]*\]|\.[^.[\]]+)$/, "");
    if (trimmed === current || trimmed === "") return undefined;
    current = trimmed;
    if (sources[current]) return sources[current];
  }
}
