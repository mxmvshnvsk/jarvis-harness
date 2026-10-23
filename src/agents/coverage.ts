import type { StepContext } from "../orchestration/types.ts";

/**
 * What an analysis document leaves uncovered of its step's goal, from the artifacts — no model. A
 * document is incomplete when it has gaps, not because its agent ran out of calls: one at its limit
 * may have covered everything, one well within it may have missed a requirement nobody would notice.
 *
 * - research: every task of the Story appears in it (a finding, a dependency, an unknown);
 * - impact: every requirement of the spec has a path it affects, or says where it is (another service,
 *   an unknown);
 * - plan: every requirement of the spec has a step, and every code path the impact lists is in a step.
 *
 * Undefined: the agent's coverage is not measured (other agents), or there is nothing to measure it by.
 */
export const MEASURED: ReadonlySet<string> = new Set(["research", "impact", "plan"]);

/** Who grants the one round to cover the gaps by itself (a `budget.grant` actor). */
export const COVERAGE_ACTOR = "service:coverage";

/** At most this many gaps go on the record and to the agent: enough to act on, not a dump. */
const MAX_GAPS = 20;

type Doc = Record<string, unknown>;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
const text = (v: unknown): string => JSON.stringify(v ?? "");
const has = (hay: string, id: string) =>
  new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`).test(hay);

function latestJson(ctx: Pick<StepContext, "runtime" | "run">, type: string): Doc | undefined {
  const a = ctx.runtime.artifacts.listLatest(ctx.run.id, type)[0];
  if (!a) return undefined;
  try {
    return JSON.parse(ctx.runtime.artifacts.text(a)) as Doc;
  } catch {
    return undefined;
  }
}

function specRequirements(ctx: Pick<StepContext, "runtime" | "run">): Array<{ id: string; text: string }> {
  return arr(latestJson(ctx, "spec")?.requirements).flatMap((r) => {
    const o = r as Doc;
    return typeof o.id === "string" ? [{ id: o.id, text: typeof o.text === "string" ? o.text : "" }] : [];
  });
}

const cut = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const normal = (p: string) => p.replace(/^\.\//, "").replace(/:\d+(-\d+)?$/, "");

export function coverageGaps(
  ctx: Pick<StepContext, "runtime" | "run">,
  agentId: string,
  doc: unknown,
): string[] | undefined {
  if (!MEASURED.has(agentId) || !doc || typeof doc !== "object") return undefined;
  const d = doc as Doc;
  let gaps: string[];
  if (agentId === "research") {
    // the Story's tasks: each a part of the task, each accounted for (the task's own key goes without saying)
    const keys = new Set<string>();
    for (const t of arr(latestJson(ctx, "story-tasks")?.tasks)) {
      const k = (t as Doc).key;
      if (typeof k === "string") keys.add(k);
    }
    if (keys.size === 0) return undefined;
    const all = text(d);
    gaps = [...keys]
      .filter((k) => !has(all, k))
      .map((k) => `the Story's task ${k}: not in the findings, dependencies or unknowns`);
  } else if (agentId === "impact") {
    const reqs = specRequirements(ctx);
    if (reqs.length === 0) return undefined;
    const tied = new Set(arr(d.affected).flatMap((a) => strs((a as Doc).requirements)));
    for (const e of arr(d.elsewhere))
      if (typeof (e as Doc).requirement === "string") tied.add((e as Doc).requirement as string);
    // said where it stands in words: a path's reason, an unknown, a risk
    const said = text([arr(d.affected).map((a) => (a as Doc).reason), d.unknowns, d.risks, d.reasons]);
    gaps = reqs
      .filter((r) => !tied.has(r.id) && !has(said, r.id))
      .map((r) => `requirement ${r.id} (${cut(r.text)}): no path it affects, nor where it is`);
  } else {
    const reqs = specRequirements(ctx);
    if (reqs.length === 0) return undefined;
    const steps = arr(d.steps).map((s) => s as Doc);
    const tied = new Set(steps.flatMap((s) => strs(s.requirements)));
    const said = text(steps.map((s) => s.description));
    const files = new Set(steps.flatMap((s) => strs(s.files)).map(normal));
    const impact = latestJson(ctx, "impact");
    const code = arr(impact?.affected)
      .map((a) => a as Doc)
      .filter((a) => a.kind === "code" && typeof a.path === "string")
      .map((a) => normal(a.path as string));
    const inStep = (p: string) =>
      files.has(p) || [...files].some((f) => f.endsWith(`/${p}`) || p.endsWith(`/${f}`));
    gaps = [
      ...reqs
        .filter((r) => !tied.has(r.id) && !has(said, r.id))
        .map((r) => `requirement ${r.id} (${cut(r.text)}): no step implements it`),
      ...[...new Set(code)]
        .filter((p) => !inStep(p))
        .map((p) => `${p}: the impact lists it, no step changes it`),
    ];
  }
  return gaps.slice(0, MAX_GAPS);
}

/** What the agent is told when its document leaves gaps: cover them, or say why they stay. */
export function gapsMessage(gaps: readonly string[]): string {
  return [
    "Your document leaves these uncovered:",
    ...gaps.map((g) => `- ${g}`),
    "Cover each — look it up where needed — or say in the document why it stays (an unknown, another service). Then produce the document again.",
  ].join("\n");
}
