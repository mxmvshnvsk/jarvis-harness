import type { Run } from "../core/domain/run.ts";
import { ANSWERS, type GivenAnswer } from "../interaction/answers.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Where each requirement of a run's spec came from, for the people who review its code: the page or the
 * issue that asked for it (title, section, its words, a link), who accepted the spec and when, and
 * what was answered at its gate. Put together by code from the run's documents — no model. Pilot: asked
 * on the PR why a field was removed, the agent answered «requirement R3 says so»; the reviewers had no
 * R3 — it was the run's spec, not the analysts' page.
 */
export interface OriginSource {
  readonly ref: string;
  readonly section?: string;
  readonly quote?: string;
  /** «Title» of the page or the issue's summary, when the sources read it. */
  readonly title?: string;
  readonly url?: string;
}

export interface RequirementOrigin {
  readonly id: string;
  readonly text: string;
  readonly sources: readonly OriginSource[];
}

export interface SpecDecision {
  readonly by: string;
  readonly at: string;
  readonly comment?: string;
}

export interface GateAnswer {
  readonly question: string;
  /** What was answered; none — the question went to the analyst or out of scope. */
  readonly answer?: string;
  readonly mode: GivenAnswer["mode"];
  readonly by: string;
}

export interface Origins {
  readonly requirements: readonly RequirementOrigin[];
  readonly accepted: readonly SpecDecision[];
  readonly answers: readonly GateAnswer[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The links the run's sources hold: a page by its id, an issue by its key (its server from `self`). */
export function linkOf(ref: string, sourcesText: string): { url?: string; title?: string } {
  const page = /^\d{4,}$/.test(ref) ? ref : /^(?:confluence:)?(\d{4,})$/.exec(ref)?.[1];
  if (page) {
    const url = new RegExp(
      `https?://[^\\s)"'<>\\]|]*(?:pageId=${page}|/pages/${page})(?![0-9])[^\\s)"'<>\\]|]*`,
    ).exec(sourcesText)?.[0];
    const title = new RegExp(`^## Confluence «([^»]+)» \\(${page}\\)`, "m").exec(sourcesText)?.[1];
    return { ...(url ? { url: url.replace(/[.,;]+$/, "") } : {}), ...(title ? { title } : {}) };
  }
  const key = /^[A-Z][A-Z0-9]+-\d+$/.exec(ref.trim().toUpperCase())?.[0];
  if (key) {
    const host = /"self"\s*:\s*"(https?:\/\/[^"]+?)\/rest\/api\//.exec(sourcesText)?.[1];
    const at = sourcesText.indexOf(`## Issue ${key}`);
    const title =
      at >= 0 ? /"summary"\s*:\s*"([^"]{1,200})"/.exec(sourcesText.slice(at, at + 20_000))?.[1] : undefined;
    return { ...(host ? { url: `${host}/browse/${key}` } : {}), ...(title ? { title } : {}) };
  }
  return /^https?:\/\//.test(ref) ? { url: ref } : {};
}

function json(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The run's spec, as accepted (else the latest), with where each requirement came from. */
export function originsOf(runtime: Runtime, run: Run): Origins | undefined {
  const latest = runtime.artifacts.listLatest(run.id, "spec")[0];
  if (!latest) return undefined;
  const versions = runtime.artifacts.versions(latest.artifactId);
  const approvedOf = (v: number) =>
    runtime.artifacts.approvalsFor(latest.artifactId, v).filter((a) => a.decision === "approve");
  const accepted = [...versions].reverse().find((v) => approvedOf(v.version).length > 0) ?? latest;
  const spec = json(runtime.artifacts.text(accepted));
  if (!spec) return undefined;
  const sourcesText = runtime.artifacts
    .listLatest(run.id, "sources")
    .map((a) => runtime.artifacts.text(a))
    .join("\n\n");
  const requirements: RequirementOrigin[] = (
    Array.isArray(spec.requirements) ? spec.requirements : []
  ).flatMap((r: unknown) => {
    const o = r as Record<string, unknown>;
    const id = str(o.id);
    const text = str(o.text);
    if (!id || !text) return [];
    const sources = (Array.isArray(o.sources) ? o.sources : []).flatMap((s: unknown) => {
      const x = s as Record<string, unknown>;
      const ref = str(x.ref);
      if (!ref) return [];
      const section = str(x.section);
      const quote = str(x.quote);
      return [
        { ref, ...(section ? { section } : {}), ...(quote ? { quote } : {}), ...linkOf(ref, sourcesText) },
      ];
    });
    return [{ id, text, sources }];
  });
  const who = (a: { actor: { id: string; display?: string | undefined } }) => a.actor.display ?? a.actor.id;
  const decided = versions.flatMap((v) => approvedOf(v.version));
  const answers: GateAnswer[] = runtime.artifacts.listLatest(run.id, ANSWERS).flatMap((a) => {
    const doc = json(runtime.artifacts.text(a));
    const forRef = str(doc?.for) ?? "";
    if (!forRef.startsWith(`${latest.artifactId}@`)) return [];
    const by = str(doc?.by) ?? "";
    return (Array.isArray(doc?.answers) ? doc.answers : []).flatMap((g: unknown) => {
      const x = g as GivenAnswer;
      if (!str(x.question)) return [];
      const answer = str(x.text);
      return [{ question: x.question, mode: x.mode, by, ...(answer ? { answer } : {}) }];
    });
  });
  return {
    requirements,
    accepted: decided.map((a) => ({
      by: who(a),
      at: a.createdAt.slice(0, 10),
      ...(a.comment ? { comment: a.comment } : {}),
    })),
    answers,
  };
}

const sourceLine = (s: OriginSource) =>
  [
    s.url ? `[${s.title ?? s.ref}](${s.url})` : s.title ? `«${s.title}» (${s.ref})` : s.ref,
    s.section ? `, ${s.section}` : "",
    s.quote ? `: «${s.quote}»` : "",
  ].join("");

/** For the agent that answers reviewers: every requirement with its origin, the spec's acceptance, the gate's answers. */
export function originsText(o: Origins): string {
  return [
    "# Where the spec's requirements came from",
    "The reviewers do not know the spec's ids (R1, R2…): they know the analysts' pages and the issues.",
    "",
    ...o.requirements.map(
      (r) =>
        `- ${r.id} «${r.text}» — ${
          r.sources.length > 0
            ? r.sources.map(sourceLine).join("; ")
            : "no page or issue says it: the analysis' own, or decided when the spec was accepted"
        }`,
    ),
    "",
    o.accepted.length > 0
      ? `The spec was accepted by ${o.accepted.map((a) => `${a.by} on ${a.at}${a.comment ? ` («${a.comment}»)` : ""}`).join("; ")}.`
      : "Nobody accepted the spec on the record.",
    ...(o.answers.length > 0
      ? [
          "Answered at the spec's gate:",
          ...o.answers.map(
            (a) =>
              `- «${a.question}» — ${
                a.answer
                  ? `«${a.answer}»${a.by ? ` (${a.by})` : ""}`
                  : a.mode === "scope"
                    ? "out of the task's scope"
                    : "left to the analyst"
              }`,
          ),
        ]
      : []),
  ].join("\n");
}

/** For the PR's description: what each requirement rests on, one line each (only those with a source). */
export function originsForPr(o: Origins): string | undefined {
  const lines = o.requirements
    .filter((r) => r.sources.length > 0)
    .map((r) => `- ${r.text} — ${r.sources.map(sourceLine).join("; ")}`);
  const decided = o.answers.filter((a) => a.answer);
  if (lines.length === 0 && decided.length === 0) return undefined;
  return [
    ...(lines.length > 0 ? ["Requirements:", ...lines] : []),
    ...(decided.length > 0
      ? [
          `${lines.length > 0 ? "\n" : ""}Decided when the spec was accepted${o.accepted[0] ? ` (${o.accepted[0].by}, ${o.accepted[0].at})` : ""}:`,
          ...decided.map((a) => `- «${a.question}» — «${a.answer}»`),
        ]
      : []),
  ].join("\n");
}
