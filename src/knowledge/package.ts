import type { KnowledgeConfig } from "../core/config/schema.ts";
import type { EngineeringContextPackage } from "./resolver.ts";
import type { GlossaryEntry } from "./retrieval/glossary.ts";
import { skillRef } from "./skills.ts";
import { standardRef } from "./standards.ts";

/**
 * Renders the EngineeringContextPackage as the L4 layer (ADR-0020 §3): skills, then standards
 * (required before recommended), then knowledge; each group has its share of the L4 budget and
 * whatever does not fit is listed by ref as available through `knowledge.read`.
 */
function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars; full text via knowledge.read]`;
}

/**
 * Fair-share fill: items that fit under the equal share keep their size, the rest split what is
 * left; an item whose share would be unreadably small (< MIN_SLICE chars) is listed by ref instead.
 */
const MIN_SLICE = 240;

function fill<T>(items: readonly T[], budget: number, render: (t: T) => string, ref: (t: T) => string) {
  const rendered = items.map((item) => ({ item, text: render(item), cap: 0 }));
  let remaining = budget;
  let pending = [...rendered];
  while (pending.length > 0) {
    const fair = Math.floor(remaining / pending.length);
    const small = pending.filter((r) => r.text.length <= fair);
    if (small.length === 0) {
      for (const r of pending) r.cap = fair;
      break;
    }
    for (const r of small) {
      r.cap = r.text.length;
      remaining -= r.text.length;
    }
    pending = pending.filter((r) => !small.includes(r));
  }
  const shown: string[] = [];
  const omitted: string[] = [];
  for (const r of rendered) {
    if (r.cap >= r.text.length) shown.push(r.text);
    else if (r.cap >= MIN_SLICE) shown.push(clip(r.text, r.cap));
    else omitted.push(ref(r.item));
  }
  return { shown, omitted };
}

/** A skill's line in a list: its description, else its title. */
function aboutOf(s: {
  readonly description?: string | undefined;
  readonly title?: string | undefined;
}): string | undefined {
  const text = (s.description ?? s.title)?.replace(/\s+/g, " ").trim();
  return text ? (text.length > 160 ? `${text.slice(0, 159)}…` : text) : undefined;
}

/** As many catalog lines as fit `budget` characters (at least 600), then how many were left out. */
function catalogLines(lines: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  const cap = Math.max(600, budget);
  for (const l of lines) {
    if (used + l.length + 1 > cap) break;
    out.push(l);
    used += l.length + 1;
  }
  if (out.length < lines.length)
    out.push(`- … ${lines.length - out.length} more (knowledge.search finds them)`);
  return out;
}

/**
 * Ranked fill: in the package's order (the index ranked the documents) each takes what it needs, at
 * most 60% of the share, while a readable slice is left — then the rest are listed by ref. An even
 * split ignored the ranking and cut every document to a few hundred characters mid-sentence (pilot).
 */
function fillRanked<T>(items: readonly T[], budget: number, render: (t: T) => string, ref: (t: T) => string) {
  const shown: string[] = [];
  const omitted: string[] = [];
  // one long document does not take everything: the next ranked ones still get their turn
  const most = Math.max(MIN_SLICE * 2, Math.floor(budget * 0.6));
  let left = budget;
  for (const item of items) {
    const text = render(item);
    const cap = Math.min(text.length, left, most);
    if (cap === text.length) {
      shown.push(text);
      left -= text.length;
    } else if (cap >= MIN_SLICE * 2) {
      shown.push(clip(text, cap));
      left -= cap;
    } else omitted.push(ref(item));
  }
  return { shown, omitted };
}

export function renderPackage(
  pkg: EngineeringContextPackage,
  chars: number,
  config: KnowledgeConfig,
): string {
  const split = config.split;
  const skills = fill(
    pkg.skills,
    Math.floor(chars * split.skills),
    (s) => `## Skill ${s.id}@${s.version}${s.title ? ` — ${s.title}` : ""}\n${s.instructions}`,
    skillRef,
  );
  const standards = fill(
    pkg.standards,
    Math.floor(chars * split.standards),
    (s) => {
      const check =
        s.verification.kind === "semantic"
          ? "checked in review"
          : `checked by ${s.verification.check?.tool ?? `pattern ${s.verification.check?.pattern?.glob ?? ""}`}`;
      return `## Standard ${s.id}@${s.version} — ${s.title} [${s.severity}; ${check}]\n${s.rule}`;
    },
    standardRef,
  );
  // what skills and standards left unused goes to the documents (an empty share was reserved for nothing)
  const used = (xs: readonly string[]) => xs.reduce((n, x) => n + x.length + 2, 0);
  const spare = Math.max(
    0,
    Math.floor(chars * split.skills) -
      used(skills.shown) +
      Math.floor(chars * split.standards) -
      used(standards.shown),
  );
  const terms = termsText(pkg.terms ?? [], Math.floor(chars * 0.08));
  const knowledge = fillRanked(
    pkg.knowledge,
    Math.floor(chars * split.knowledge) + spare - terms.length,
    (k) =>
      `## Knowledge ${k.name}${k.generated ? " (generated by jarvis onboard — check what you rely on against the code)" : ""}\n${k.text}`,
    (k) => `knowledge:${k.name}`,
  );
  const sections: string[] = [];
  if (skills.shown.length > 0)
    sections.push(`# Skills (how to do this kind of work)\n${skills.shown.join("\n\n")}`);
  if (standards.shown.length > 0)
    sections.push(
      `# Standards (required ones are verified; violations send the work back)\n${standards.shown.join("\n\n")}`,
    );
  if (terms) sections.push(terms);
  if (knowledge.shown.length > 0) sections.push(`# Project knowledge\n${knowledge.shown.join("\n\n")}`);
  // a skill on request says what it is for: the agent asks for the one it needs by that, not by its id
  const said = new Map(
    [...pkg.skills, ...pkg.deferredSkills, ...pkg.catalogSkills].map((s) => [skillRef(s), aboutOf(s)]),
  );
  const line = (ref: string) => (said.get(ref) ? `- ${ref} — ${said.get(ref)}` : `- ${ref}`);
  const onRequest = [
    ...skills.omitted,
    ...pkg.deferredSkills.map(skillRef),
    ...standards.omitted,
    ...knowledge.omitted,
  ];
  if (onRequest.length > 0)
    sections.push(`# Available on request (knowledge.read <ref>)\n${onRequest.map(line).join("\n")}`);
  // every other skill there is, in a line each, within a small budget: the ones for other agents go first
  const catalog = catalogLines(pkg.catalogSkills.map(skillRef).map(line), Math.floor(chars * 0.05));
  if (catalog.length > 0)
    sections.push(`# Other skills (knowledge.read <ref> when one fits your work)\n${catalog.join("\n")}`);
  return sections.join("\n\n");
}

/**
 * The glossary's entries the task names: its words and the code they are in. Only the query was
 * expanded with them, the agents never saw them — and research is asked for exactly these links.
 */
function termsText(terms: readonly GlossaryEntry[], budget: number): string {
  if (terms.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const e of terms) {
    const also = e.synonyms.length > 0 ? ` (${e.synonyms.join(", ")})` : "";
    const code = e.symbols.length > 0 ? ` → ${e.symbols.map((x) => `\`${x}\``).join(", ")}` : "";
    const what = e.definition ? ` — ${e.definition.replace(/\s+/g, " ").slice(0, 200)}` : "";
    const line = `- ${e.term}${also}${code}${what}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 0 ? `# Terms of this task (the project's glossary)\n${lines.join("\n")}` : "";
}
