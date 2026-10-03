import type { KnowledgeConfig } from "../core/config/schema.ts";
import type { EngineeringContextPackage } from "./resolver.ts";
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
  const knowledge = fill(
    pkg.knowledge,
    Math.floor(chars * split.knowledge),
    (k) => `## Knowledge ${k.name}\n${k.text}`,
    (k) => `knowledge:${k.name}`,
  );
  const sections: string[] = [];
  if (skills.shown.length > 0)
    sections.push(`# Skills (how to do this kind of work)\n${skills.shown.join("\n\n")}`);
  if (standards.shown.length > 0)
    sections.push(
      `# Standards (required ones are verified; violations send the work back)\n${standards.shown.join("\n\n")}`,
    );
  if (knowledge.shown.length > 0) sections.push(`# Project knowledge\n${knowledge.shown.join("\n\n")}`);
  const onRequest = [
    ...skills.omitted,
    ...pkg.deferredSkills.map(skillRef),
    ...standards.omitted,
    ...knowledge.omitted,
  ];
  if (onRequest.length > 0)
    sections.push(
      `# Available on request (knowledge.read <ref>)\n${onRequest.map((r) => `- ${r}`).join("\n")}`,
    );
  return sections.join("\n\n");
}
