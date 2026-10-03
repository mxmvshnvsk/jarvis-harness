import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { KnowledgeConfig } from "../core/config/schema.ts";
import { capabilityMatches } from "../tools/registry.ts";
import { globMatches, parseFrontMatter } from "./frontmatter.ts";
import { loadSkills, type Skill, skillRef } from "./skills.ts";
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
}

export function loadKnowledgeDocs(roots: KnowledgeRoots): KnowledgeDoc[] {
  const dirs = [roots.projectRoot ? join(roots.projectRoot, ".jarvis", "knowledge") : undefined];
  const out: KnowledgeDoc[] = [];
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    // glossary.md is a lookup table for query expansion (ADR-0015 §3), not a document for agents
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".md") && x !== "README.md" && x !== "glossary.md")
      .sort()) {
      const raw = readFileSync(join(dir, f), "utf8");
      const { data, body } = parseFrontMatter(raw);
      const fm = KnowledgeFrontMatter.safeParse(data);
      const meta = fm.success ? fm.data : { tags: [], paths: [], stacks: [], agents: [] };
      out.push({
        name: f,
        text: body.trim(),
        sha: createHash("sha256").update(raw).digest("hex").slice(0, 12),
        scope: { stacks: meta.stacks, paths: meta.paths, agents: meta.agents },
        tags: meta.tags,
      });
    }
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
  /** `standard:ID@v`, `skill:id@v`, `knowledge:name#sha` — goes into artifact provenance. */
  readonly provenance: string[];
}

interface Match {
  readonly matched: boolean;
  /** Number of scope constraints that applied (higher = more specific). */
  readonly specificity: number;
}

function matchScope(scope: Scope & { agents?: string[]; kinds?: string[] }, task: TaskScope): Match {
  let specificity = 0;
  if (scope.stacks.length > 0) {
    if (task.stacks.length > 0 && !scope.stacks.some((s) => task.stacks.includes(s)))
      return { matched: false, specificity };
    specificity += 1;
  }
  if (scope.paths.length > 0) {
    if (task.affectedPaths.length > 0 && !task.affectedPaths.some((p) => globMatches(p, scope.paths))) {
      return { matched: false, specificity };
    }
    specificity += 1;
  }
  if (scope.kinds && scope.kinds.length > 0) {
    if (!scope.kinds.includes(task.kind)) return { matched: false, specificity };
    specificity += 1;
  }
  if (scope.agents && scope.agents.length > 0) {
    if (!scope.agents.includes(task.agentId)) return { matched: false, specificity };
    specificity += 1;
  }
  return { matched: true, specificity };
}

export interface ResolveInput {
  readonly roots: KnowledgeRoots;
  readonly config: KnowledgeConfig;
  readonly task: TaskScope;
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
          b.m.specificity - a.m.specificity ||
          (a.item.id ?? a.item.name ?? "").localeCompare(b.item.id ?? b.item.name ?? ""),
      )
      .map((x) => x.item);

  // Skills without an explicit agent list are for the implementation agent (ADR-0020 §1).
  const skillsRanked = rank(skills, (s) =>
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
  const selectedSkills = skillsRanked.slice(0, input.config.maxSkills);
  const deferredSkills = skillsRanked.slice(input.config.maxSkills);

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
  if (!rest) return undefined;
  const id = rest.split("@")[0]?.split("#")[0] as string;
  if (kind === "standard") {
    const s = loadStandards(roots).find((x) => x.id === id);
    return s ? `# Standard ${s.id}@${s.version} — ${s.title} [${s.severity}]\n${s.rule}` : undefined;
  }
  if (kind === "skill") {
    const s = loadSkills(roots).find((x) => x.id === id);
    return s ? `# Skill ${s.id}@${s.version}${s.title ? ` — ${s.title}` : ""}\n${s.instructions}` : undefined;
  }
  if (kind === "knowledge") {
    const d = loadKnowledgeDocs(roots).find((x) => x.name === id);
    return d ? `# Knowledge ${d.name}\n${d.text}` : undefined;
  }
  return undefined;
}
