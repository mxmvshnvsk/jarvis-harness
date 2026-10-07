import type { ConfigIssue } from "./errors.ts";
import { DATA_CLASS_ORDER, type ProfileOverlay, type ResolvedConfig } from "./schema.ts";

/**
 * Applies a profile overlay (ADR-0009 §1, ADR-0014 §1). A profile may only narrow the base
 * configuration: raise the data class, forbid writes, deny capabilities, lower budgets.
 * Any attempt to widen is reported as an issue and the overlay is not applied.
 */
export interface ProfileApplication {
  readonly config: ResolvedConfig;
  readonly issues: readonly ConfigIssue[];
  /** Leaf paths changed by the profile, for source tracking. */
  readonly changed: readonly string[];
}

export function effectiveAllowWrites(config: ResolvedConfig): boolean {
  return config.workspace.allowWrites ?? config.workspace.mode === "worktree";
}

export function applyProfile(
  base: ResolvedConfig,
  name: string,
  overlay: ProfileOverlay,
): ProfileApplication {
  const issues: ConfigIssue[] = [];
  const changed: string[] = [];
  const prefix = `profiles.${name}`;

  const next: ResolvedConfig = structuredClone(base);
  next.profile = name;
  changed.push("profile");

  if (overlay.dataClass !== undefined) {
    if (DATA_CLASS_ORDER[overlay.dataClass] < DATA_CLASS_ORDER[base.dataClass]) {
      issues.push({
        path: `${prefix}.dataClass`,
        message: `profile may not lower dataClass from "${base.dataClass}" to "${overlay.dataClass}"`,
      });
    } else {
      next.dataClass = overlay.dataClass;
      changed.push("dataClass");
    }
  }

  if (overlay.interactive !== undefined) {
    next.interactive = overlay.interactive;
    changed.push("interactive");
  }

  if (overlay.humanGate !== undefined) {
    next.humanGate = overlay.humanGate;
    changed.push("humanGate");
  }

  if (overlay.workspace) {
    if (overlay.workspace.mode !== undefined) {
      next.workspace.mode = overlay.workspace.mode;
      changed.push("workspace.mode");
    }
    if (overlay.workspace.allowWrites !== undefined) {
      if (overlay.workspace.allowWrites && !effectiveAllowWrites(base)) {
        issues.push({
          path: `${prefix}.workspace.allowWrites`,
          message: "profile may not enable writes that the base configuration forbids",
        });
      } else {
        next.workspace.allowWrites = overlay.workspace.allowWrites;
        changed.push("workspace.allowWrites");
      }
    }
  }

  const denies = [...(overlay.mcp?.deny ?? []), ...(overlay.tools?.deny ?? [])];
  if (denies.length > 0) {
    next.deniedCapabilities = [...new Set([...base.deniedCapabilities, ...denies])];
    changed.push("deniedCapabilities");
  }

  if (overlay.budget) {
    for (const scope of ["perRun", "perStep"] as const) {
      const baseCap = base.budget[scope];
      const cap = overlay.budget[scope];
      for (const key of ["outputTokens", "inputTokens", "requests"] as const) {
        const value = cap[key];
        if (value === undefined) continue;
        const current = baseCap[key];
        if (current !== undefined && value > current) {
          issues.push({
            path: `${prefix}.budget.${scope}.${key}`,
            message: `profile may not raise ${scope}.${key} above ${current}`,
          });
        } else {
          next.budget[scope][key] = value;
          changed.push(`budget.${scope}.${key}`);
        }
      }
    }
  }

  return { config: next, issues, changed };
}
