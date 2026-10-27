import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type { Actor } from "../core/domain/actor.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import { layoutOf, rootRelative, versionedAt } from "../core/paths.ts";
import { SHARED_KNOWLEDGE_PREFIX } from "../knowledge/resolver.ts";
import { shortRunId } from "../storage/runStore.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A knowledge document the code disagrees with, as a run found it: research and impact say which
 * document, what it claims, what the code does and where (`knowledgeDrift[]`). After the run each
 * finding is checked without a model — the document says it, the cited lines are in the code — and
 * a document's checked findings become one candidate (`knowledge-fix`). Until a person decides, the
 * next runs see the document with the findings («the code wins»), and `jarvis onboard --stale` maps
 * the module again with them in its note; accepting writes them into the document next to what they
 * correct. Pilot: agents worked around a stale map and said so in prose; the next run tripped on it again.
 */
export interface DriftItem {
  /** The section of the document (its heading), when the agent named one. */
  readonly section?: string;
  /** What the document says. */
  readonly claim: string;
  /** What the code does instead. */
  readonly actual: string;
  /** Where in the code: `path:line` or `path:from-to`. */
  readonly sources: readonly string[];
}

export interface DriftFinding extends DriftItem {
  /** The document's name as the agent saw it (`module-billing.md`, `common/landscape.md`). */
  readonly doc: string;
}

/** A candidate's findings on one document: its name and its path in the repository it is versioned in. */
export interface DriftProposal {
  readonly doc: string;
  readonly path: string;
  readonly items: readonly DriftItem[];
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** `knowledgeDrift` of an artifact's JSON; none for anything else. */
export function driftIn(text: string): DriftFinding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (doc as { knowledgeDrift?: unknown } | null)?.knowledgeDrift;
  if (!Array.isArray(list)) return [];
  const out: DriftFinding[] = [];
  for (const d of list) {
    const name = str(d?.doc).replace(/^`|`$/g, "");
    const claim = str(d?.claim);
    const actual = str(d?.actual);
    const sources = Array.isArray(d?.sources)
      ? (d.sources as unknown[])
          .map(str)
          .map((s) => s.replace(/^`|`$/g, ""))
          .filter(Boolean)
      : [];
    const section = str(d?.section);
    if (name && claim && actual && sources.length > 0)
      out.push({ doc: name, claim, actual, sources, ...(section ? { section } : {}) });
  }
  return out;
}

/** The file of a knowledge document by the name agents see it under. */
export function knowledgeFileOf(root: string, name: string): string {
  const layout = layoutOf(root);
  if (name.startsWith(SHARED_KNOWLEDGE_PREFIX) && layout.meta)
    return join(layout.meta.knowledgeRoot, name.slice(SHARED_KNOWLEDGE_PREFIX.length));
  const own = join(layout.knowledgeDir, name);
  return existsSync(own) ? own : isAbsolute(name) ? name : join(root, name);
}

/** A document's path in the repository it is versioned in (the knowledge repository's for a service). */
export function versionedPathOf(root: string, file: string): string {
  return versionedAt(layoutOf(root), rootRelative(root, file)).path;
}

/** The file of a versioned path, from `root`. */
export function fileOfVersioned(root: string, path: string): string {
  const meta = layoutOf(root).meta;
  return meta ? join(meta.root, path) : join(root, path);
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[`*_«»"'“”()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The document says it: the claim as written, or most of its words (≥ 4 letters) in the section — an
 * agent quotes loosely. A claim with fewer than two such words must be there as written.
 */
export function claimIn(docText: string, claim: string, section?: string): boolean {
  const scope = sectionText(docText, section) ?? docText;
  const hay = words(scope);
  const needle = words(claim);
  if (needle.length >= 8 && hay.includes(needle)) return true;
  const own = [...new Set(needle.split(" ").filter((w) => [...w].length >= 4))];
  if (own.length < 2) return needle.length > 0 && hay.includes(needle);
  const have = new Set(hay.split(" "));
  return own.filter((w) => have.has(w)).length / own.length >= 0.7;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Where a section is: its heading line and the line before the next heading of its level or above. */
function sectionAt(lines: readonly string[], section: string): { head: number; end: number } | undefined {
  const want = words(section).replace(/^#+\s*/, "");
  if (!want) return undefined;
  const at = lines.findIndex((l) => {
    const m = HEADING.exec(l);
    if (!m) return false;
    const h = words(m[2] as string);
    return h === want || (h.length > 2 && (h.includes(want) || want.includes(h)));
  });
  if (at < 0) return undefined;
  const level = (HEADING.exec(lines[at] as string)?.[1] ?? "#").length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const m = HEADING.exec(lines[i] as string);
    if (m && (m[1] as string).length <= level) {
      end = i;
      break;
    }
  }
  return { head: at, end };
}

function sectionText(text: string, section?: string): string | undefined {
  if (!section) return undefined;
  const lines = text.split("\n");
  const at = sectionAt(lines, section);
  return at ? lines.slice(at.head, at.end).join("\n") : undefined;
}

/** The cited lines are in the code: `path:line[-line]`, the file in `root`, long enough. */
export function citedLinesIn(root: string, source: string): boolean {
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(source.trim());
  if (!m) return false;
  const rel = normalize(m[1] as string).replace(/^[/\\]+/, "");
  if (rel.startsWith("..")) return false;
  const file = resolve(root, rel);
  if (!existsSync(file)) return false;
  try {
    const n = readFileSync(file, "utf8").split("\n").length;
    return Number(m[2]) >= 1 && Number(m[3] ?? m[2]) <= n;
  } catch {
    return false;
  }
}

export type DriftCheck =
  | { readonly ok: true; readonly file: string; readonly path: string; readonly sources: readonly string[] }
  | { readonly ok: false; readonly why: string };

/** A finding as the checks see it: the document is there and says it, a cited line is in the code. */
export function checkDrift(root: string, f: DriftFinding): DriftCheck {
  const file = knowledgeFileOf(root, f.doc);
  if (!existsSync(file)) return { ok: false, why: `no knowledge document ${f.doc}` };
  if (!claimIn(readFileSync(file, "utf8"), f.claim, f.section))
    return { ok: false, why: `${f.doc} does not say «${f.claim.slice(0, 80)}»` };
  const sources = f.sources.filter((s) => citedLinesIn(root, s));
  if (sources.length === 0)
    return { ok: false, why: `no cited line is in the code (${f.sources.join(", ")})` };
  return { ok: true, file, path: versionedPathOf(root, file), sources };
}

const keyOf = (path: string, claim: string) => `${path}\0${words(claim)}`;

/** The newest version a person edited of each artifact of these types, else the latest. */
function preferred(runtime: Runtime, runId: string, types: readonly string[]): ArtifactVersion[] {
  return types.flatMap((type) =>
    runtime.artifacts.listLatest(runId, type).map((latest) => {
      const versions = runtime.artifacts.versions(latest.artifactId);
      return [...versions].reverse().find((v) => v.provenance.kind === "human") ?? latest;
    }),
  );
}

/** Every drift candidate with its decision (open ones have none), oldest first. */
function driftCandidates(runtime: Runtime): Array<{
  artifact: ArtifactVersion;
  drift: DriftProposal;
  decision?: string;
}> {
  const out: Array<{ artifact: ArtifactVersion; drift: DriftProposal; decision?: string }> = [];
  for (const run of runtime.runs.list({ includeTerminal: true, limit: 100_000 }).reverse())
    for (const artifact of runtime.artifacts.listLatest(run.id, "candidate")) {
      if (!artifact.name?.startsWith("knowledge-fix-")) continue;
      try {
        const doc = JSON.parse(runtime.artifacts.text(artifact)) as { kind?: string; drift?: DriftProposal };
        if (doc.kind !== "knowledge-fix" || !doc.drift) continue;
        const decision = runtime.artifacts.approvalsFor(artifact.artifactId, artifact.version)[0]?.decision;
        out.push({ artifact, drift: doc.drift, ...(decision ? { decision } : {}) });
      } catch {
        // not a candidate document
      }
    }
  return out;
}

/** What runs found and no person decided yet, by the document's versioned path. */
export function openDrift(runtime: Runtime): Map<string, DriftItem[]> {
  const out = new Map<string, DriftItem[]>();
  for (const c of driftCandidates(runtime))
    if (!c.decision) out.set(c.drift.path, [...(out.get(c.drift.path) ?? []), ...c.drift.items]);
  return out;
}

/** One line per finding: what the agent of the next run reads, what the mapper's note says. */
export const driftLine = (i: DriftItem) =>
  `${i.section ? `${i.section}: ` : ""}the document says «${i.claim}», the code: ${i.actual} (${i.sources.join(", ")})`;

/**
 * After a completed run: its research's and impact's checked findings, one candidate per document;
 * a finding proposed before (open or decided) is not proposed again. Deterministic, no model call.
 */
export function proposeDriftCandidates(runtime: Runtime, run: Run): ArtifactVersion[] {
  const root = run.workspace.repoRoot;
  const found = preferred(runtime, run.id, ["research", "impact"]).flatMap((a) =>
    driftIn(runtime.artifacts.text(a)).map((f) => ({ f, ref: `${a.artifactId}@${a.version}` })),
  );
  if (found.length === 0) return [];
  const seen = new Set(
    driftCandidates(runtime).flatMap((c) => c.drift.items.map((i) => keyOf(c.drift.path, i.claim))),
  );
  const byDoc = new Map<string, { doc: string; items: DriftItem[]; from: Set<string> }>();
  const dropped: string[] = [];
  for (const { f, ref } of found) {
    const check = checkDrift(root, f);
    if (!check.ok) {
      dropped.push(check.why);
      continue;
    }
    const key = keyOf(check.path, f.claim);
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = byDoc.get(check.path) ?? { doc: f.doc, items: [], from: new Set<string>() };
    entry.items.push({
      ...(f.section ? { section: f.section } : {}),
      claim: f.claim,
      actual: f.actual,
      sources: check.sources,
    });
    entry.from.add(ref);
    byDoc.set(check.path, entry);
  }
  const out: ArtifactVersion[] = [];
  for (const [path, e] of byDoc) {
    const drift: DriftProposal = { doc: e.doc, path, items: e.items };
    const doc = {
      kind: "knowledge-fix",
      title: `fix ${e.doc.replace(/\.md$/, "")}`,
      rationale: `run ${shortRunId(run.id)} found ${e.items.length} place(s) where ${path} disagrees with the code`,
      proposal: e.items.map((i) => `- ${driftLine(i)}`).join("\n"),
      evidence: e.items.flatMap((i) => i.sources),
      from: [...e.from].join(", "),
      status: "proposed",
      drift,
    };
    out.push(
      runtime.artifacts.put({
        runId: run.id,
        type: "candidate",
        name: `knowledge-fix-${out.length + 1}.json`,
        content: JSON.stringify(doc, null, 2),
        mediaType: "application/json",
        provenance: { kind: "tool", capability: "knowledge.drift" },
        sourceRefs: [...e.from],
        stepId: "knowledge-drift",
      }),
    );
  }
  if (out.length > 0 || dropped.length > 0)
    runtime.events.emit({
      kind: "knowledge.drift",
      runId: run.id,
      payload: { proposed: out.length, dropped: dropped.slice(0, 10) },
    });
  return out;
}

/**
 * The findings written into the document next to what they correct: a quoted line under the section
 * they name (else at the end) — the code wins until the module is mapped again.
 */
export function withDriftNotes(text: string, items: readonly DriftItem[], stamp: string): string {
  let lines = text.replace(/\n+$/, "").split("\n");
  const note = (i: DriftItem) =>
    `> ⚠ ${i.actual} — ${i.sources.map((s) => `\`${s}\``).join(", ")}; ✗ «${i.claim.slice(0, 200)}» (${stamp})`;
  const tail: string[] = [];
  for (const i of items) {
    const at = i.section ? sectionAt(lines, i.section) : undefined;
    if (!at) {
      tail.push(note(i));
      continue;
    }
    let end = at.end;
    while (end - 1 > at.head && (lines[end - 1] as string).trim() === "") end -= 1;
    lines = [...lines.slice(0, end), "", note(i), ...lines.slice(end)];
  }
  if (tail.length > 0) lines = [...lines, "", ...tail];
  return `${lines.join("\n")}\n`;
}

/** Accepting: the findings go into the document. */
export function writeDrift(root: string, drift: DriftProposal, stamp: string): string {
  const file = fileOfVersioned(root, drift.path);
  if (!existsSync(file)) throw new Error(`${drift.path} is not there any more`);
  writeFileSync(file, withDriftNotes(readFileSync(file, "utf8"), drift.items, stamp));
  return file;
}

/** The module was mapped again: what runs found on its old document is settled by the new one. */
export function closeDrift(runtime: Runtime, path: string, actor: Actor, comment: string): number {
  let n = 0;
  for (const c of driftCandidates(runtime)) {
    if (c.decision || c.drift.path !== path) continue;
    runtime.artifacts.approve({
      runId: c.artifact.runId,
      stepId: c.artifact.stepId ?? "knowledge-drift",
      artifactId: c.artifact.artifactId,
      version: c.artifact.version,
      actor,
      decision: "approve",
      comment,
    });
    n += 1;
  }
  return n;
}
