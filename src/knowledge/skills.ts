import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
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

function readSkillsDir(dir: string, level: Skill["level"]): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory())
    .sort()
    .map((d) => readSkill(join(dir, d), level));
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

/** Project skills override built-ins by id; user skills only add ids nobody else defines. */
export function loadSkills(roots: KnowledgeRoots): Skill[] {
  const project = roots.projectRoot
    ? readSkillsDir(join(roots.projectRoot, ".jarvis", "skills"), "project")
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
  const local = [...project, ...fromSources];
  const localIds = new Set(local.map((s) => s.id));
  const builtin = BUILTIN_SKILLS.filter((s) => !localIds.has(s.id));
  const taken = new Set([...localIds, ...builtin.map((s) => s.id)]);
  const user = roots.userRoot
    ? readSkillsDir(join(roots.userRoot, "skills"), "user").filter((s) => !taken.has(s.id))
    : [];
  return [...local, ...builtin, ...user];
}

export function skillRef(s: Pick<Skill, "id" | "version">): string {
  return `skill:${s.id}@${s.version}`;
}
