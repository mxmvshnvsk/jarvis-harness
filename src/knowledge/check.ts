import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../tools/local/exec.ts";
import { globMatches } from "./frontmatter.ts";
import type { Standard } from "./standards.ts";

/**
 * Deterministic verification of standards (ADR-0020 §2): `pattern` checks over the changed files,
 * `tool` checks through a capability. Semantic standards are left to review.
 */
export interface Violation {
  readonly standardId: string;
  readonly version: number;
  readonly severity: Standard["severity"];
  readonly file?: string;
  readonly line?: number;
  readonly detail: string;
}

export interface CheckReport {
  /** `standard:ID@v` of every deterministic/hybrid standard that was evaluated. */
  readonly checked: string[];
  readonly skipped: Array<{ standard: string; reason: string }>;
  readonly violations: Violation[];
  readonly files: string[];
}

export type ToolRunner = (
  capability: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; text: string; denied?: string }>;

/** Files changed against the base ref plus untracked ones; falls back to "all tracked" outside git. */
export async function changedFiles(workspace: string, baseRef: string): Promise<string[]> {
  const diff = await git(["diff", "--name-only", "--diff-filter=ACMR", baseRef, "--"], workspace);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], workspace);
  if (diff.code !== 0 && untracked.code !== 0) {
    const all = await git(["ls-files"], workspace);
    return all.code === 0 ? all.stdout.split("\n").filter(Boolean) : [];
  }
  const set = new Set([
    ...(diff.code === 0 ? diff.stdout.split("\n") : []),
    ...(untracked.code === 0 ? untracked.stdout.split("\n") : []),
  ]);
  set.delete("");
  return [...set].sort();
}

/**
 * Line numbers (1-based, in the new version) each file adds against `baseRef`; an untracked or new
 * file adds all of its lines (`"all"`).
 */
export async function addedLines(
  workspace: string,
  baseRef: string,
  files: readonly string[],
): Promise<Map<string, Set<number> | "all">> {
  const out = new Map<string, Set<number> | "all">();
  if (files.length === 0) return out;
  const tracked = await git(["ls-files", "--", ...files], workspace);
  const known = new Set(tracked.code === 0 ? tracked.stdout.split("\n").filter(Boolean) : []);
  const diff = await git(["diff", "-U0", "--no-color", "--no-ext-diff", baseRef, "--", ...files], workspace);
  let current: string | undefined;
  if (diff.code === 0) {
    for (const line of diff.stdout.split("\n")) {
      if (line.startsWith("+++ ")) {
        const path = line.slice(4).trim();
        current = path === "/dev/null" ? undefined : path.replace(/^b\//, "");
        if (current) out.set(current, out.get(current) ?? new Set<number>());
        continue;
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk && current) {
        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        const set = out.get(current);
        if (set instanceof Set) for (let n = start; n < start + count; n += 1) set.add(n);
      }
    }
    // a file new since the base shows up with a "--- /dev/null" header and all lines added: same thing
  }
  for (const f of files) if (!known.has(f) || (diff.code !== 0 && !out.has(f))) out.set(f, "all");
  return out;
}

function regex(source: string): RegExp {
  return new RegExp(source);
}

export async function checkStandards(input: {
  readonly standards: readonly Standard[];
  readonly workspace: string;
  readonly files: readonly string[];
  readonly runTool?: ToolRunner;
  /** The base of the change: `mustNot` with `lines: added` then judges only the lines it adds. */
  readonly baseRef?: string;
}): Promise<CheckReport> {
  // pilot: rules from the team's AGENTS.md are for new code; the legacy lines of a touched file are not
  // the change's violations, and sending the implementation back over them could never succeed
  const needsAdded =
    input.baseRef !== undefined &&
    input.standards.some(
      (s) =>
        s.verification.kind !== "semantic" &&
        s.verification.check?.pattern?.mustNot &&
        s.verification.check.pattern.lines === "added",
    );
  const added = needsAdded
    ? await addedLines(input.workspace, input.baseRef as string, input.files)
    : undefined;
  const checked: string[] = [];
  const skipped: CheckReport["skipped"] = [];
  const violations: Violation[] = [];
  for (const s of input.standards) {
    if (s.verification.kind === "semantic" || !s.verification.check) continue;
    const ref = `standard:${s.id}@${s.version}`;
    const check = s.verification.check;
    if (check.pattern) {
      const matching = input.files.filter((f) => globMatches(f, [check.pattern?.glob as string]));
      checked.push(ref);
      for (const file of matching) {
        const full = join(input.workspace, file);
        if (!existsSync(full)) continue;
        const text = readFileSync(full, "utf8");
        if (check.pattern.must && !regex(check.pattern.must).test(text)) {
          violations.push({
            standardId: s.id,
            version: s.version,
            severity: s.severity,
            file,
            detail: `missing required pattern /${check.pattern.must}/`,
          });
        }
        if (check.pattern.mustNot) {
          const re = regex(check.pattern.mustNot);
          const only =
            check.pattern.lines === "added" && added ? (added.get(file) ?? new Set<number>()) : "all";
          text.split("\n").forEach((lineText, i) => {
            if (only !== "all" && !only.has(i + 1)) return;
            if (re.test(lineText))
              violations.push({
                standardId: s.id,
                version: s.version,
                severity: s.severity,
                file,
                line: i + 1,
                detail: `forbidden pattern /${check.pattern?.mustNot}/: ${lineText.trim().slice(0, 120)}`,
              });
          });
        }
      }
    }
    if (check.tool) {
      if (!input.runTool) {
        skipped.push({ standard: ref, reason: "tool checks need a run context" });
        continue;
      }
      const result = await input.runTool(check.tool, check.args);
      if (result.denied) {
        skipped.push({ standard: ref, reason: `${check.tool} denied: ${result.denied}` });
        continue;
      }
      if (!checked.includes(ref)) checked.push(ref);
      if (!result.ok) {
        violations.push({
          standardId: s.id,
          version: s.version,
          severity: s.severity,
          detail: `${check.tool} failed:\n${result.text.slice(0, 2000)}`,
        });
      }
    }
  }
  return { checked, skipped, violations, files: [...input.files] };
}
