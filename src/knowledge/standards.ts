import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { KnowledgeSource } from "../core/config/schema.ts";
import { parseFrontMatter } from "./frontmatter.ts";

/**
 * Standards (ADR-0020 §1–2): typed, versioned rules in `.jarvis/standards/<id>.md` — YAML front
 * matter plus the rule text. `deterministic` / `hybrid` verification must name a `check`.
 */
export const ScopeSchema = z.strictObject({
  stacks: z.array(z.string().min(1)).default([]),
  paths: z.array(z.string().min(1)).default([]),
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
  const { data, body } = parseFrontMatter(text);
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

function readDir(dir: string, level: Standard["level"]): Standard[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => parseStandard(join(dir, f), readFileSync(join(dir, f), "utf8"), level));
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
    ? readDir(join(roots.projectRoot, ".jarvis", "standards"), "project")
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
