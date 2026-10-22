import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { KnowledgeConfig } from "../core/config/schema.ts";
import { layoutOf } from "../core/paths.ts";
import { capabilityMatches } from "../tools/registry.ts";
import { catalogOf, neighboursDoc } from "./catalog.ts";
import { globMatches, parseFrontMatter } from "./frontmatter.ts";
import { reportProblem } from "./problems.ts";
import { loadSkills, type Skill, skillRef } from "./skills.ts";
import { loadSourceDocuments } from "./sources.ts";
import { type KnowledgeRoots, loadStandards, type Scope, type Standard, standardRef } from "./standards.ts";

/**
 * Resolver (ADR-0020 §3): selects skills, standards and knowledge for one agent call and builds the
 * EngineeringContextPackage. Deterministic: same inputs → same package, so the prefix cache holds
 * across the tool rounds of a step (ADR-0013).
 */
const KnowledgeFrontMatter = z
  .object({
    tags: z.array(z.string()).default([]),
    paths: z.array(z.string()).default([]),
    stacks: z.array(z.string()).default([]),
    agents: z.array(z.string()).default([]),
  })
  .loose();

export interface KnowledgeDoc {
  readonly name: string;
  readonly text: string;
  readonly sha: string;
  readonly scope: Scope & { agents: string[] };
  readonly tags: string[];
  /** Written by `jarvis onboard` (not a person): facts of when it ran, possibly older than the code. */
  readonly generated?: boolean /** Commits under its paths since it was last edited (the step's first documents): it may be out of date. */;
  readonly staleCommits?: number;
}

/** Name prefix of a knowledge repository's shared documents (`landscape.md` → `common/landscape.md`). */
export const SHARED_KNOWLEDGE_PREFIX = "common/";

/**
 * The documents of a knowledge folder, its subfolders too (`architecture/payments.md`), by their path
 * in it: only the top level was read, and a team's folders of documents never reached an agent. The
 * glossary and the READMEs are not documents; a knowledge repository's root does not take its
 * services' folders (each service has its own).
 */
export function knowledgeFilesIn(dir: string, options: { skipServices?: boolean } = {}): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth >= 4 || e.name.startsWith(".")) continue;
        if (options.skipServices && !rel && e.name === "services") continue;
        walk(join(at, e.name), path, depth + 1);
      } else if (
        /\.md$/i.test(e.name) &&
        !/^readme\.md$/i.test(e.name) &&
        !(!rel && e.name === "glossary.md")
      )
        out.push(path);
    }
  };
  walk(dir, "", 0);
  return out;
}

export function loadKnowledgeDocs(roots: KnowledgeRoots): KnowledgeDoc[] {
  const layout = roots.projectRoot ? layoutOf(roots.projectRoot) : undefined;
  // the project's documents, and a knowledge repository's shared ones beside its services' (ADR-0025 §4)
  const dirs: Array<readonly [string, string]> = layout ? [[layout.knowledgeDir, ""]] : [];
  if (layout?.meta?.service) dirs.push([layout.meta.knowledgeRoot, SHARED_KNOWLEDGE_PREFIX]);
  const out: KnowledgeDoc[] = [];
  for (const [dir, prefix] of dirs) {
    if (!existsSync(dir)) continue;
    // glossary.md is a lookup table for query expansion (ADR-0015 §3), not a document for agents
    for (const f of knowledgeFilesIn(dir, { skipServices: dir === layout?.meta?.knowledgeRoot })) {
      const raw = readFileSync(join(dir, f), "utf8");
      const { data, body, error } = parseFrontMatter(raw);
      if (error) reportProblem(join(dir, f), `front matter is not valid YAML: ${error}`);
      const fm = KnowledgeFrontMatter.safeParse(data);
      if (!error && !fm.success)
        reportProblem(
          join(dir, f),
          `front matter: ${fm.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      const meta = fm.success ? fm.data : { tags: [], paths: [], stacks: [], agents: [] };
      // written by jarvis onboard (its marker line): said to the agent; the marker itself is not text
      const generated = /<!-- jarvis:onboard/.test(raw);
      out.push({
        name: `${prefix}${f}`,
        text: body.replace(/^<!-- jarvis:[^\n]*-->\n?/gm, "").trim(),
        ...(generated ? { generated: true } : {}),
        sha: createHash("sha256").update(raw).digest("hex").slice(0, 12),
        scope: { stacks: meta.stacks, paths: meta.paths, agents: meta.agents },
        tags: meta.tags,
      });
    }
  }
  // a service's neighbours, from the knowledge repository's contract catalog (ADR-0025 §4)
  if (layout?.meta?.service) {
    const text = neighboursDoc(catalogOf(layout.meta.root), layout.meta.service);
    if (text)
      out.push({
        name: `${SHARED_KNOWLEDGE_PREFIX}neighbours.md`,
        text,
        sha: createHash("sha256").update(text).digest("hex").slice(0, 12),
        scope: { stacks: [], paths: [], agents: [] },
        tags: ["neighbours", "contracts"],
      });
  }
  // knowledge.sources: the team's documentation in place; its skills are loaded as skills instead
  for (const d of loadSourceDocuments(roots)) {
    if (d.skill) continue;
    out.push({
      name: d.path,
      text: d.text,
      sha: d.sha,
      scope: { stacks: d.stacks, paths: d.paths, agents: d.agents },
      tags: d.tags,
    });
  }
  return out;
}

export interface TaskScope {
  /** feature | change | fix | refactor | test | docs — "change" when unknown. */
  readonly kind: string;
  /** From the impact artifact; empty before impact analysis (then path scopes do not exclude). */
  readonly affectedPaths: readonly string[];
  readonly stacks: readonly string[];
  readonly agentId: string;
}

export interface EngineeringContextPackage {
  readonly task: TaskScope;
  readonly skills: Skill[];
  readonly standards: Standard[];
  readonly knowledge: KnowledgeDoc[];
  /** Everything that matched but was cut by maxSkills — available on request via knowledge.read. */
  readonly deferredSkills: Skill[];
  /**
   * Every other skill, as a catalog line (id and what it is for): an agent sees all the skills there are,
   * not only those its task was matched to, and asks for one it needs. Those meant for other agents last.
   */
  readonly catalogSkills: Skill[];
  /**
   * How the skills were chosen: `step` — the workflow step names them; `picked` — by the task's kind,
   * stacks, paths and agent. `missing`: ids the step names that no skill has.
   */
  readonly skillsBy: { readonly how: "step" | "picked"; readonly missing?: readonly string[] };
  /** `standard:ID@v`, `skill:id@v`, `knowledge:name#sha` — goes into artifact provenance. */
  readonly provenance: string[];
  /** The glossary's entries the task names (src/agents/knowledge.ts): shown to the agent with their code. */
  readonly terms?: readonly import("./retrieval/glossary.ts").GlossaryEntry[];
}

interface Match {
  readonly matched: boolean;
  /** Number of scope constraints that applied (higher = more specific). */
  readonly specificity: number;
  /**
   * A path scope that could not be judged: the task's paths are unknown before impact analysis.
   * Such an item may apply, but it ranks after everything that certainly applies.
   */
  readonly unsure?: boolean;
}

function matchScope(
  scope: Scope & { agents?: string[] | undefined; kinds?: string[] | undefined },
  task: TaskScope,
): Match {
  let specificity = 0;
  if (scope.stacks.length > 0) {
    if (task.stacks.length > 0 && !scope.stacks.some((s) => task.stacks.includes(s)))
      return { matched: false, specificity };
    specificity += 1;
  }
  let unsure = false;
  if (scope.paths.length > 0) {
    if (task.affectedPaths.length === 0) {
      // pilot: path-scoped skills from the team's documentation outranked sdd-implementation for every
      // task before impact analysis — an unknown path is not a match
      unsure = true;
    } else {
      if (!task.affectedPaths.some((p) => globMatches(p, scope.paths)))
        return { matched: false, specificity };
      specificity += 1;
    }
  }
  if (scope.kinds && scope.kinds.length > 0) {
    if (!scope.kinds.includes(task.kind)) return { matched: false, specificity };
    specificity += 1;
  }
  if (scope.agents && scope.agents.length > 0) {
    if (!scope.agents.includes(task.agentId)) return { matched: false, specificity };
    specificity += 1;
  }
  return unsure ? { matched: true, specificity, unsure } : { matched: true, specificity };
}

export interface ResolveInput {
  readonly roots: KnowledgeRoots;
  readonly config: KnowledgeConfig;
  readonly task: TaskScope;
  /** The skills the workflow step names (StepDefinition.skills): given as they are, nothing picked. */
  readonly stepSkills?: readonly string[];
}

export function resolvePackage(input: ResolveInput): EngineeringContextPackage {
  const { task } = input;
  const skills = loadSkills(input.roots);
  const standards = loadStandards(input.roots);
  const docs = loadKnowledgeDocs(input.roots);

  const rank = <T extends { id?: string; name?: string }>(items: readonly T[], match: (t: T) => Match) =>
    items
      .map((item) => ({ item, m: match(item) }))
      .filter((x) => x.m.matched)
      .sort(
        (a, b) =>
          Number(a.m.unsure === true) - Number(b.m.unsure === true) ||
          b.m.specificity - a.m.specificity ||
          (a.item.id ?? a.item.name ?? "").localeCompare(b.item.id ?? b.item.name ?? ""),
      )
      .map((x) => x.item);

  // Skills without an explicit agent list are for the implementation agent (ADR-0020 §1).
  const skillsRanked = rank(
    skills.filter((s) => !s.catalogOnly),
    (s) =>
      matchScope(
        {
          stacks: s.appliesTo.stacks,
          paths: s.appliesTo.paths,
          kinds: s.appliesTo.kinds,
          agents: s.appliesTo.agents.length > 0 ? s.appliesTo.agents : ["implementation"],
        },
        task,
      ),
  );
  const byId = new Map(skills.map((s) => [s.id, s]));
  const named = input.stepSkills;
  const selectedSkills = named
    ? named.map((id) => byId.get(id)).filter((s): s is Skill => s !== undefined)
    : skillsRanked.slice(0, input.config.maxSkills);
  // what else matched stays available on request, as with picking
  const deferredSkills = named
    ? skillsRanked.filter((s) => !named.includes(s.id))
    : skillsRanked.slice(input.config.maxSkills);
  const missing = named?.filter((id) => !byId.has(id)) ?? [];
  const given = new Set([...selectedSkills, ...deferredSkills].map((s) => s.id));
  const forOthers = (s: Skill) =>
    s.appliesTo.agents.length > 0
      ? !s.appliesTo.agents.includes(task.agentId)
      : task.agentId !== "implementation";
  const rest = skills.filter((s) => !given.has(s.id));
  const catalogSkills = [
    ...rest.filter((s) => !forOthers(s) || s.catalogOnly),
    ...rest.filter((s) => forOthers(s) && !s.catalogOnly),
  ];

  const required = selectedSkills.flatMap((s) => s.requiredStandards);
  const standardsRanked = rank(standards, (s) => {
    if (required.some((pattern) => capabilityMatches(s.id, pattern)))
      return { matched: true, specificity: 10 };
    return matchScope(s.scope, task);
  }).sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "required" ? -1 : 1;
    return 0;
  });

  const knowledge = rank(docs, (d) => matchScope(d.scope, task));

  return {
    task,
    skills: selectedSkills,
    standards: stableBySeverity(standardsRanked),
    knowledge,
    deferredSkills,
    catalogSkills,
    skillsBy: named ? { how: "step", ...(missing.length > 0 ? { missing } : {}) } : { how: "picked" },
    provenance: [
      ...selectedSkills.map(skillRef),
      ...standardsRanked.map(standardRef),
      ...knowledge.map((k) => `knowledge:${k.name}#${k.sha}`),
    ],
  };
}

/** required first (keeping the specificity order within each group). */
function stableBySeverity(items: Standard[]): Standard[] {
  return [
    ...items.filter((s) => s.severity === "required"),
    ...items.filter((s) => s.severity !== "required"),
  ];
}

/** Reads one item by its provenance ref for the `knowledge.read` tool. */
export function readByRef(roots: KnowledgeRoots, ref: string): string | undefined {
  const [kind, rest] = ref.split(":", 2) as [string, string | undefined];
  // a bare name (`conventions.md`, `documentation/billing/overview.md`) is a knowledge document
  if (!rest) return readByRef(roots, `knowledge:${ref}`);
  const id = rest.split("@")[0]?.split("#")[0] as string;
  if (kind === "standard") {
    const s = loadStandards(roots).find((x) => x.id === id);
    return s ? `# Standard ${s.id}@${s.version} — ${s.title} [${s.severity}]\n${s.rule}` : undefined;
  }
  if (kind === "skill") {
    // `skill:<name>/references/x.md`: a file of an Agent Skills skill, never one of its scripts
    const [skillId, ...inside] = id.split("/");
    const s = loadSkills(roots).find((x) => x.id === skillId);
    if (!s) return undefined;
    if (inside.length > 0) {
      const file = inside.join("/");
      if (!s.dir || file.startsWith("scripts/") || file.split("/").includes("..")) return undefined;
      const path = join(s.dir, file);
      return existsSync(path) && statSync(path).isFile() && statSync(path).size < 200_000
        ? `# Skill ${s.id}: ${file}\n${readFileSync(path, "utf8")}`
        : undefined;
    }
    return `# Skill ${s.id}@${s.version}${s.title ? ` — ${s.title}` : ""}\n${s.instructions}`;
  }
  if (kind === "knowledge") {
    const d = loadKnowledgeDocs(roots).find((x) => x.name === id);
    return d ? `# Knowledge ${d.name}\n${d.text}` : undefined;
  }
  return undefined;
}
