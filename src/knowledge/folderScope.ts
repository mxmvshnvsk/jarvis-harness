import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { reportProblem } from "./problems.ts";

/**
 * A folder of standards or skills says whom they are for: `_scope.yaml` beside them —
 * `{ stacks: [<stack>] }`, also `paths`, `kinds`, `agents`. What a file says itself wins; the folder fills
 * what it leaves empty, and a subfolder's file over its parent's. So a knowledge repository of many
 * services keeps its backend rules in `standards/backend/` and its frontend's in `standards/frontend/`, and a
 * rule put there does not reach the other stack (pilot: 25 backend standards with no scope went to every
 * agent of the frontend). `common/_scope.yaml` with nothing in it says «everyone» on purpose.
 */
export interface FolderScope {
  readonly stacks?: readonly string[];
  readonly paths?: readonly string[];
  readonly kinds?: readonly string[];
  readonly agents?: readonly string[];
}

export const FOLDER_SCOPE_FILE = "_scope.yaml";

const KEYS = ["stacks", "paths", "kinds", "agents"] as const;

/** The folder's `_scope.yaml`, its keys at the top or under `scope:` / `appliesTo:`; undefined — none. */
export function folderScopeOf(dir: string): FolderScope | undefined {
  const file = join(dir, FOLDER_SCOPE_FILE);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8")) ?? {};
  } catch (error) {
    reportProblem(file, `not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  const top = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const body = (top.scope ?? top.appliesTo ?? top) as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const key of KEYS) {
    const v = body?.[key];
    if (v === undefined) continue;
    const list = (Array.isArray(v) ? v : [v]).filter(
      (x): x is string => typeof x === "string" && x.trim() !== "",
    );
    out[key] = list.map((x) => x.trim());
  }
  return out;
}

/** A child folder's scope over its parent's: each key it names replaces the parent's. */
export function nestedScope(
  parent: FolderScope | undefined,
  child: FolderScope | undefined,
): FolderScope | undefined {
  if (!parent) return child;
  if (!child) return parent;
  return { ...parent, ...child };
}

/** What the folder adds to a file's own lists: only those the file leaves empty. */
export function withFolderScope<
  T extends Partial<Record<(typeof KEYS)[number], readonly string[] | undefined>>,
>(own: T, folder: FolderScope | undefined): T {
  if (!folder) return own;
  const out: Record<string, unknown> = { ...own };
  for (const key of KEYS) {
    const mine = own[key];
    const theirs = folder[key];
    if ((mine === undefined || mine.length === 0) && theirs && theirs.length > 0) out[key] = [...theirs];
  }
  return out as T;
}
