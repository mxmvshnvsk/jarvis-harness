import { createHash } from "node:crypto";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import { shortRunId } from "../storage/runStore.ts";
import { type CandidateDoc, candidatesRunOf } from "./candidates.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Candidates from a repeated finding (ADR-0020 §6), without a model: when review finds the same issue in
 * two runs or more, that issue is a rule nobody wrote down. The finding's text is reduced to a key —
 * what stays when the instance is taken out (paths, line numbers, quoted names, numbers, filler words) —
 * and a key found in reviews of different runs of this repository becomes one `standard` candidate.
 * The same key later adds its runs to that candidate while it is open; once decided, it is left alone.
 */

interface Finding {
  readonly severity?: string;
  readonly file?: string;
  readonly line?: number;
  readonly issue?: string;
  readonly suggestion?: string;
}

/** One finding of one review, where it was. */
export interface Occurrence {
  readonly run: Run;
  readonly review: ArtifactVersion;
  readonly issue: string;
  readonly suggestion?: string;
  readonly file?: string;
  readonly line?: number;
}

const STOPWORDS = new Set(
  (
    "a an the is are was were be been being of to in on at by for from with without into onto as and or " +
    "but not no it its this that these those there here which who than then so such should must can could " +
    "may might will would does do did has have had also only just still yet very"
  ).split(" "),
);

/** Fewer words than this left after normalising: too little to tell one issue from another. */
const MIN_WORDS = 3;

/**
 * What stays of a finding when its instance is taken out: lower case; quoted spans (`code`, "text",
 * «text»), paths and file names, `line 12` / `:12`, numbers and punctuation removed; filler words
 * dropped; the words left, once each, sorted — so the order a reviewer wrote them in does not matter.
 */
export function normalizeFinding(issue: string): string {
  const words = issue
    .toLowerCase()
    .replace(/`[^`]*`|"[^"]*"|“[^”]*”|«[^»]*»/g, " ")
    .replace(/\S*[/\\]\S*/g, " ")
    .replace(/\b[\w-]+\.[a-z][a-z0-9]{0,4}\b(:\d+)?/g, " ")
    .replace(/\blines?\s+\d+([-–]\d+)?/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return [...new Set(words)].sort().join(" ");
}

/** The stable key of a finding, or none when too little is left of it to compare. */
export function findingKey(issue: string): string | undefined {
  const normalized = normalizeFinding(issue);
  if (normalized.split(" ").length < MIN_WORDS) return undefined;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/**
 * A review version's findings as read once: a version never changes, and every review of a run read
 * every version of every run of the repository again (pilot: 0.7 s before the gate at 300 runs).
 */
const readFindings = new Map<string, Finding[] | null>();
const READ_FINDINGS_MAX = 20_000;

/** Every finding of every review version of a run (a review that went round has a version per round). */
function occurrencesOf(runtime: Runtime, run: Run): Occurrence[] {
  const out: Occurrence[] = [];
  for (const latest of runtime.artifacts.listLatest(run.id, "review")) {
    for (const review of runtime.artifacts.versions(latest.artifactId)) {
      const id = `${review.artifactId}@${review.version}`;
      let known = readFindings.get(id);
      if (known === undefined) {
        try {
          const doc = JSON.parse(runtime.artifacts.text(review)) as { findings?: unknown };
          known = Array.isArray(doc.findings) ? (doc.findings as Finding[]) : [];
        } catch {
          known = null; // not a review document
        }
        if (readFindings.size >= READ_FINDINGS_MAX) readFindings.clear();
        readFindings.set(id, known);
      }
      if (known === null) continue;
      const findings = known;
      if (findings.length === 0) continue;
      for (const f of findings) {
        if (typeof f?.issue !== "string" || !f.issue.trim()) continue;
        out.push({
          run,
          review,
          issue: f.issue.trim(),
          ...(typeof f.suggestion === "string" && f.suggestion.trim()
            ? { suggestion: f.suggestion.trim() }
            : {}),
          ...(typeof f.file === "string" && f.file ? { file: f.file } : {}),
          ...(typeof f.line === "number" ? { line: f.line } : {}),
        });
      }
    }
  }
  return out;
}

/** Findings of this repository's runs grouped by key, only the keys `only` names (oldest run first). */
export function findingsByKey(
  runtime: Runtime,
  root: string,
  only: ReadonlySet<string>,
): Map<string, Occurrence[]> {
  const groups = new Map<string, Occurrence[]>();
  const runs = runtime.runs
    .list({ includeTerminal: true, limit: 100_000 })
    .filter((r) => r.workspace.repoRoot === root)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const run of runs)
    for (const o of occurrencesOf(runtime, run)) {
      const key = findingKey(o.issue);
      if (!key || !only.has(key)) continue;
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
  return groups;
}

const cut = (text: string, max: number) => {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The candidate a repeated finding becomes: the newest wording, every run and place it was found. */
export function repeatedCandidateOf(
  key: string,
  occurrences: readonly Occurrence[],
): CandidateDoc & Required<Pick<CandidateDoc, "evidence" | "finding">> {
  const latest = occurrences.at(-1) as Occurrence;
  const runs = [...new Set(occurrences.map((o) => o.run.id))];
  const places = [
    ...new Set(
      occurrences.filter((o) => o.file).map((o) => (o.line ? `${o.file}:${o.line}` : (o.file as string))),
    ),
  ];
  const reviews = [...new Set(occurrences.map((o) => `${o.review.artifactId}@${o.review.version}`))];
  const suggestion = [...occurrences].reverse().find((o) => o.suggestion)?.suggestion;
  return {
    kind: "standard",
    title: cut(latest.issue, 80),
    rationale: `Review found the same issue in ${runs.length} runs (${runs.map(shortRunId).join(", ")}); a rule nobody wrote down yet.`,
    proposal: suggestion
      ? `${suggestion}\n\nThe issue review kept finding: ${latest.issue}\n`
      : `${latest.issue}\n`,
    evidence: [...places, ...reviews],
    from: reviews.at(-1) as string,
    finding: { key, runs },
    status: "proposed",
  };
}

/**
 * After a review step: the issues of this run's review found in another run too become candidates (or
 * add to their open candidate). Returns the candidates written. Deterministic: the same reviews give
 * the same candidates.
 */
export function proposeRepeatedFindings(runtime: Runtime, run: Run): ArtifactVersion[] {
  const root = run.workspace.repoRoot;
  const keys = new Set(
    occurrencesOf(runtime, run)
      .map((o) => findingKey(o.issue))
      .filter((k): k is string => k !== undefined),
  );
  if (keys.size === 0) return [];
  const written: ArtifactVersion[] = [];
  for (const [key, occurrences] of findingsByKey(runtime, root, keys)) {
    if (new Set(occurrences.map((o) => o.run.id)).size < 2) continue;
    const home = candidatesRunOf(runtime, root, run.owner);
    const name = `finding-${key}.json`;
    const existing = runtime.artifacts.find(home.id, "candidate", name);
    const fresh = repeatedCandidateOf(key, occurrences);
    let doc: CandidateDoc = fresh;
    if (existing) {
      // decided: a person said yes or no to this rule; review repeating it does not reopen it
      if (runtime.artifacts.approvalsFor(existing.artifactId, existing.version).length > 0) continue;
      const before = JSON.parse(runtime.artifacts.text(existing)) as CandidateDoc;
      if (JSON.stringify(before.evidence) === JSON.stringify(fresh.evidence)) continue;
      // the title and the text stay as first written; the runs and places grow
      doc = { ...before, rationale: fresh.rationale, evidence: fresh.evidence, finding: fresh.finding };
    }
    const artifact = runtime.artifacts.put({
      runId: home.id,
      type: "candidate",
      name,
      content: JSON.stringify(doc, null, 2),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "review.repeated-findings" },
      sourceRefs: fresh.evidence,
      stepId: "candidates",
    });
    runtime.events.emit({
      kind: existing ? "candidate.evidence" : "candidate.added",
      runId: home.id,
      payload: {
        artifact: artifact.artifactId,
        kind: "standard",
        title: doc.title,
        from: "repeated-finding",
        key,
        runs: fresh.finding.runs.length,
        trigger: run.id,
      },
    });
    written.push(artifact);
  }
  return written;
}
