import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { layoutOf } from "../core/paths.ts";
import { reportProblem } from "./problems.ts";
import { loadSourceDocuments, skillIdOf } from "./sources.ts";
import type { KnowledgeRoots } from "./standards.ts";

/**
 * Skills (ADR-0020 §1): how to carry out one type of engineering work, in
 * `.jarvis/skills/<id>/{skill.yaml,instructions.md}`. Built-in generic skills ship with Jarvis and
 * are overridden by project skills with the same id.
 */
export const SkillManifestSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  version: z.int().positive().default(1),
  title: z.string().min(1).optional(),
  appliesTo: z
    .strictObject({
      stacks: z.array(z.string().min(1)).default([]),
      /** Task kinds: feature | change | fix | refactor | test | docs. Empty = any. */
      kinds: z.array(z.string().min(1)).default([]),
      paths: z.array(z.string().min(1)).default([]),
      /** Agents this skill is for (ids). Empty = implementation. */
      agents: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  inputs: z.array(z.string().min(1)).default([]),
  outputs: z.array(z.string().min(1)).default([]),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  /** Standard id patterns this skill depends on (glob). */
  requiredStandards: z.array(z.string().min(1)).default([]),
  verification: z.array(z.string().min(1)).default([]),
  evals: z.array(z.string().min(1)).default([]),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export interface Skill extends SkillManifest {
  readonly instructions: string;
  readonly level: "builtin" | "project" | "user";
  readonly dir?: string;
  /** Repository path of a skill read from `knowledge.sources`. */
  readonly source?: string;
  /** What the skill is for, in a line: the agent sees it in the catalog and asks for the skill by it. */
  readonly description?: string;
  /** A skill in the open Agent Skills format (`<name>/SKILL.md`), shared with other coding agents. */
  readonly format?: "agent-skills";
  /**
   * Nothing says what it applies to (an Agent Skills `SKILL.md` without `jarvis/*` metadata): never
   * picked by kind, stack or paths — listed in every agent's catalog, given when a step names it.
   */
  readonly catalogOnly?: boolean;
}

export class SkillLoadError extends Error {
  constructor(dir: string, message: string) {
    super(`${dir}: ${message}`);
    this.name = "SkillLoadError";
  }
}

function readSkill(dir: string, level: Skill["level"]): Skill {
  const manifestFile = join(dir, "skill.yaml");
  if (!existsSync(manifestFile)) throw new SkillLoadError(dir, "skill.yaml is missing");
  const raw: unknown = parse(readFileSync(manifestFile, "utf8"));
  const parsed = SkillManifestSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new SkillLoadError(
      dir,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  const instructionsFile = join(dir, "instructions.md");
  if (!existsSync(instructionsFile)) throw new SkillLoadError(dir, "instructions.md is missing");
  return { ...parsed.data, instructions: readFileSync(instructionsFile, "utf8").trim(), level, dir };
}

/**
 * The skills of a folder. A subfolder without `skill.yaml` is not a skill (notes, an `IMPROVEMENT.md`
 * left by hand) and is passed over: pilot — one such folder failed every agent call of the project. A
 * folder with a broken `skill.yaml` is passed over too, and said (jarvis skills, doctor).
 */
function readSkillsDir(dir: string, level: Skill["level"]): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, "skill.yaml")))
    .sort()
    .flatMap((d) => {
      try {
        return [readSkill(join(dir, d), level)];
      } catch (error) {
        reportProblem(join(dir, d), error instanceof Error ? error.message : String(error));
        return [];
      }
    });
}

export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    id: "sdd-implementation",
    version: 1,
    title: "Implement an approved plan",
    appliesTo: { stacks: [], kinds: [], paths: [], agents: ["implementation"] },
    inputs: ["spec", "plan"],
    outputs: ["implementation"],
    requiredCapabilities: ["repo.read", "repo.edit"],
    requiredStandards: [],
    verification: ["project.*"],
    evals: [],
    level: "builtin",
    instructions: `Procedure:
1. Read the plan step by step; open every file it names before changing it.
2. Make the smallest change that satisfies the requirement; keep the existing style of the file.
3. After each step run the verification the plan names (project commands) and read the output.
4. Do not touch files outside the plan without recording why in "notes".
5. Leave no debugging output, commented-out code or TODOs without an owner.`,
  },
  {
    id: "unit-testing",
    version: 1,
    title: "Write and run unit tests for a change",
    appliesTo: { stacks: [], kinds: [], paths: [], agents: ["test", "implementation"] },
    inputs: ["spec", "implementation"],
    outputs: ["tests"],
    requiredCapabilities: ["project.*"],
    requiredStandards: [],
    verification: ["project.*"],
    evals: [],
    level: "builtin",
    instructions: `Procedure:
1. Map every acceptance criterion of the spec to at least one test; name tests after the behaviour.
2. Put tests next to existing tests of the same module and use the project's test runner.
3. Cover the failure and boundary cases the spec lists, not only the happy path.
4. Run the whole relevant test command, not a single file, before reporting "passed".`,
  },
  {
    id: "refactor",
    version: 1,
    title: "Behaviour-preserving refactoring",
    appliesTo: { stacks: [], kinds: ["refactor"], paths: [], agents: ["implementation"] },
    inputs: ["plan"],
    outputs: ["implementation"],
    requiredCapabilities: ["repo.read", "repo.edit", "repo.search"],
    requiredStandards: [],
    verification: ["project.*"],
    evals: [],
    level: "builtin",
    instructions: `Procedure:
1. Establish the safety net first: the tests that cover the code must pass before any change.
2. Move in small steps (rename, extract, inline) and run the tests after each step.
3. Never change behaviour and structure in the same step; if a bug is found, record it in "notes".
4. Update every reference found by search, including tests and documentation.`,
  },
];

/** `a, b` or a YAML list in `metadata` → a list. */
function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string")
    return v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return [];
}

/**
 * Skills in the open Agent Skills format (agentskills.io): `<dir>/<name>/SKILL.md` with `name` and
 * `description` in its front matter — the folders Claude Code, opencode and Codex read too, so a team
 * keeps one set. What Jarvis needs beyond that sits in `metadata`, as other tools put theirs:
 * `jarvis/agents`, `jarvis/kinds`, `jarvis/stacks`, `jarvis/paths` (comma-separated), `jarvis/version`.
 * Only the text is read: files under `scripts/` are never run; others can be read by ref
 * (`skill:<name>/references/x.md`). A folder without SKILL.md, or a SKILL.md without a name, is passed over.
 */
function readAgentSkillsDir(dir: string, level: Skill["level"]): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const d of readdirSync(dir).sort()) {
    const file = join(dir, d, "SKILL.md");
    if (!existsSync(file) || !statSync(join(dir, d)).isDirectory()) continue;
    const text = readFileSync(file, "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    let front: Record<string, unknown> = {};
    try {
      front = m ? ((parse(m[1] as string) as Record<string, unknown> | null) ?? {}) : {};
    } catch {
      continue;
    }
    const name = typeof front.name === "string" && front.name.trim() ? front.name.trim() : undefined;
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
    const meta = (front.metadata ?? {}) as Record<string, unknown>;
    const agents = listOf(meta["jarvis/agents"]);
    const kinds = listOf(meta["jarvis/kinds"]);
    const stacks = listOf(meta["jarvis/stacks"]);
    const paths = listOf(meta["jarvis/paths"]);
    const version = Number(meta["jarvis/version"]);
    out.push({
      id: name,
      version: Number.isInteger(version) && version > 0 ? version : 1,
      ...(typeof front.description === "string" ? { description: front.description.trim() } : {}),
      appliesTo: { stacks, kinds, paths, agents },
      inputs: [],
      outputs: [],
      requiredCapabilities: [],
      requiredStandards: [],
      verification: [],
      evals: [],
      level,
      dir: join(dir, d),
      format: "agent-skills",
      ...(agents.length + kinds.length + stacks.length + paths.length === 0 ? { catalogOnly: true } : {}),
      instructions: (m ? (m[2] as string) : text).trim(),
    });
  }
  return out;
}

/** The Agent Skills folders of a root: `.agents/skills` and `.claude/skills`, in that order. */
const agentSkillsDirs = (root: string) => [join(root, ".agents", "skills"), join(root, ".claude", "skills")];

/**
 * Project skills override built-ins by id; user skills only add ids nobody else defines. In the project:
 * `.jarvis/skills`, the team's documentation, then `.agents/skills` and `.claude/skills`; for the person:
 * `~/.jarvis/skills`, `~/.agents/skills`, `~/.claude/skills`.
 */
export function loadSkills(roots: KnowledgeRoots): Skill[] {
  const project = roots.projectRoot
    ? readSkillsDir(join(layoutOf(roots.projectRoot).jarvisDir, "skills"), "project")
    : [];
  const projectIds = new Set(project.map((s) => s.id));
  // knowledge.sources: skills kept in the team's documentation; `.jarvis/skills` wins by id
  const fromSources: Skill[] = [];
  for (const d of loadSourceDocuments(roots)) {
    if (!d.skill) continue;
    const id = skillIdOf(d.path, new Set([...projectIds, ...fromSources.map((s) => s.id)]));
    fromSources.push({
      id,
      version: 1,
      ...(d.title ? { title: d.title } : {}),
      appliesTo: { stacks: d.stacks, kinds: [], paths: d.paths, agents: d.agents },
      inputs: [],
      outputs: [],
      requiredCapabilities: [],
      requiredStandards: [],
      verification: [],
      evals: [],
      level: "project",
      source: d.path,
      instructions: d.text,
    });
  }
  const shared: Skill[] = [];
  for (const dir of roots.projectRoot ? agentSkillsDirs(roots.projectRoot) : []) {
    const seen = new Set([...projectIds, ...fromSources.map((s) => s.id), ...shared.map((s) => s.id)]);
    shared.push(...readAgentSkillsDir(dir, "project").filter((s) => !seen.has(s.id)));
  }
  const local = [...project, ...fromSources, ...shared];
  const localIds = new Set(local.map((s) => s.id));
  const builtin = BUILTIN_SKILLS.filter((s) => !localIds.has(s.id));
  const taken = new Set([...localIds, ...builtin.map((s) => s.id)]);
  const user: Skill[] = [];
  if (roots.userRoot) {
    // the home folder next to `~/.jarvis`; a JARVIS_HOME elsewhere (a test, a sandbox) reads only its own
    const home = basename(roots.userRoot) === ".jarvis" ? dirname(roots.userRoot) : undefined;
    const own = [
      ...readSkillsDir(join(roots.userRoot, "skills"), "user"),
      ...(home ? agentSkillsDirs(home).flatMap((d) => readAgentSkillsDir(d, "user")) : []),
    ];
    for (const s of own) if (!taken.has(s.id) && !user.some((u) => u.id === s.id)) user.push(s);
  }
  return [...local, ...builtin, ...user];
}

/**
 * `skill:id@v`; a person's own skill is `skill:id@user` — it is not in the repository, so a run that had it
 * may not repeat elsewhere (an eval case made from it says so).
 */
export function skillRef(s: Pick<Skill, "id" | "version"> & { readonly level?: Skill["level"] }): string {
  return `skill:${s.id}@${s.level === "user" ? "user" : s.version}`;
}
