import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { KnowledgeSource } from "../core/config/schema.ts";
import { layoutOf } from "../core/paths.ts";
import { type FolderScope, folderScopeOf, nestedScope, withFolderScope } from "./folderScope.ts";
import { parseFrontMatter } from "./frontmatter.ts";
import { reportProblem } from "./problems.ts";

/**
 * Standards (ADR-0020 §1–2): typed, versioned rules in `.jarvis/standards/<id>.md` — YAML front
 * matter plus the rule text. `deterministic` / `hybrid` verification must name a `check`.
 */
export const ScopeSchema = z.strictObject({
  stacks: z.array(z.string().min(1)).default([]),
  paths: z.array(z.string().min(1)).default([]),
  /** Kinds of task it applies to (documented in run.ts and ADR-0020; a standard with them failed to load). */
  kinds: z.array(z.string().min(1)).optional(),
  /** The agents it is for; none — every agent the paths and stacks match. */
  agents: z.array(z.string().min(1)).optional(),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const CheckSchema = z.strictObject({
  pattern: z
    .strictObject({
      glob: z.string().min(1),
      /** Regex that must appear in every matching file. */
      must: z.string().min(1).optional(),
      /** Regex that must not appear on any line of a matching file. */
      mustNot: z.string().min(1).optional(),
      /**
       * Which lines `mustNot` judges: `added` — only lines the change adds (a rule for new code in a
       * legacy codebase; touching an old file does not make its old lines violations), `all` — every
       * line of a changed file. Without a base to compare with, every line is judged.
       */
      lines: z.enum(["added", "all"]).default("added"),
    })
    .optional(),
  /** A capability (`project.lint`, `project.format`, `code.diagnostics`) whose success is the check. */
  tool: z.string().min(1).optional(),
  args: z.record(z.string(), z.unknown()).prefault({}),
});
export type Check = z.infer<typeof CheckSchema>;

export const StandardFrontMatterSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    version: z.int().positive().default(1),
    title: z.string().min(1),
    scope: ScopeSchema.prefault({}),
    severity: z.enum(["required", "recommended"]).default("required"),
    verification: z
      .strictObject({
        kind: z.enum(["deterministic", "semantic", "hybrid"]).default("semantic"),
        check: CheckSchema.optional(),
      })
      .prefault({}),
    source: z.strictObject({ kind: z.string().min(1), ref: z.string().min(1) }).optional(),
    tags: z.array(z.string().min(1)).default([]),
  })
  .superRefine((s, ctx) => {
    const v = s.verification;
    if (v.kind !== "semantic") {
      if (!v.check || (!v.check.pattern && !v.check.tool)) {
        ctx.addIssue({
          code: "custom",
          path: ["verification", "check"],
          message: `verification.kind "${v.kind}" requires a check (pattern or tool) (ADR-0020 §2)`,
        });
      } else if (v.check.pattern && !v.check.pattern.must && !v.check.pattern.mustNot) {
        ctx.addIssue({
          code: "custom",
          path: ["verification", "check", "pattern"],
          message: "pattern needs must or mustNot",
        });
      }
    }
  });

export interface Standard extends z.infer<typeof StandardFrontMatterSchema> {
  /** The rule text (markdown body). */
  readonly rule: string;
  readonly file: string;
  /** project | user (user-level standards are never `required`, ADR-0020 §5). */
  readonly level: "project" | "user";
  /** The subfolder it lies in (`backend`, `frontend/web`), if not at the top. */
  readonly group?: string;
  /** A folder's `_scope.yaml` says whom it is for (it may still apply everywhere, on purpose). */
  readonly folderScoped?: boolean;
}

export class StandardLoadError extends Error {
  readonly file: string;
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "StandardLoadError";
    this.file = file;
  }
}

export function parseStandard(file: string, text: string, level: Standard["level"]): Standard {
  const { data, body, error } = parseFrontMatter(text);
  if (error) throw new StandardLoadError(file, `front matter is not valid YAML: ${error}`);
  const parsed = StandardFrontMatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new StandardLoadError(
      file,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  const expectedId = basename(file).replace(/\.md$/, "");
  if (parsed.data.id !== expectedId)
    throw new StandardLoadError(file, `id "${parsed.data.id}" must equal the file name "${expectedId}"`);
  const severity = level === "user" ? "recommended" : parsed.data.severity;
  return { ...parsed.data, severity, rule: body.trim(), file, level };
}

/**
 * The standards of a folder and its subfolders (by stack: `backend/`, `frontend/`, `common/`), each
 * folder's `_scope.yaml` filling what a standard's own scope leaves empty (src/knowledge/folderScope.ts).
 * An id met twice is kept once, and said.
 */
function readDir(dir: string, level: Standard["level"]): Standard[] {
  if (!existsSync(dir)) return [];
  const out: Standard[] = [];
  const seen = new Map<string, string>();
  const walk = (at: string, group: string, inherited: FolderScope | undefined, depth: number) => {
    const own = folderScopeOf(at);
    const folder = nestedScope(inherited, own);
    const entries = readdirSync(at).sort();
    for (const f of entries) {
      const file = join(at, f);
      if (statSync(file).isDirectory()) {
        if (depth < 3 && !f.startsWith(".") && !f.startsWith("_"))
          walk(file, group ? `${group}/${f}` : f, folder, depth + 1);
        continue;
      }
      if (!f.endsWith(".md") || f === "README.md" || f.startsWith("_")) continue;
      // one broken standard is passed over (and said), not every step of the project failed
      try {
        const parsed = parseStandard(file, readFileSync(file, "utf8"), level);
        const before = seen.get(parsed.id);
        if (before) {
          reportProblem(file, `id "${parsed.id}" is taken by ${before}: this one is passed over`);
          continue;
        }
        seen.set(parsed.id, file);
        out.push({
          ...parsed,
          scope: withFolderScope(parsed.scope, folder),
          ...(group ? { group } : {}),
          ...(folder ? { folderScoped: true } : {}),
        });
      } catch (error) {
        reportProblem(file, error instanceof Error ? error.message : String(error));
      }
    }
  };
  walk(dir, "", undefined, 0);
  return out;
}

export interface KnowledgeRoots {
  readonly projectRoot?: string | undefined;
  /** `~/.jarvis` */
  readonly userRoot?: string | undefined;
  /** `knowledge.sources`: documentation read in place from the project root. */
  readonly sources?: readonly KnowledgeSource[] | undefined;
  /** `security.deniedPaths`: a denied document is never read. */
  readonly isDenied?: ((relative: string) => boolean) | undefined;
}

/** Project standards first; user-level ones only when the id is not taken by the project. */
export function loadStandards(roots: KnowledgeRoots): Standard[] {
  const project = roots.projectRoot
    ? readDir(join(layoutOf(roots.projectRoot).jarvisDir, "standards"), "project")
    : [];
  const ids = new Set(project.map((s) => s.id));
  const user = roots.userRoot
    ? readDir(join(roots.userRoot, "standards"), "user").filter((s) => !ids.has(s.id))
    : [];
  return [...project, ...user];
}

export function standardRef(s: Pick<Standard, "id" | "version">): string {
  return `standard:${s.id}@${s.version}`;
}
