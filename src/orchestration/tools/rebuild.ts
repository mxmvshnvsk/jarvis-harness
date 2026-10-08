import { globMatches } from "../../knowledge/frontmatter.ts";

export interface RebuildRule {
  readonly when: readonly string[];
  readonly run: string;
}

/**
 * The `tools.rebuild` commands a set of changed files calls for (src/core/config/schema.ts): each
 * `tools.local` name once, in the order of the config.
 */
export function rebuildsFor(
  tools: { readonly rebuild?: readonly RebuildRule[] },
  changed: readonly string[],
): string[] {
  const names: string[] = [];
  for (const r of tools.rebuild ?? []) {
    if (!names.includes(r.run) && changed.some((f) => globMatches(f, r.when))) names.push(r.run);
  }
  return names;
}
