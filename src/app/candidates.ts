import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { stringify } from "yaml";
import type { Actor } from "../core/domain/actor.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import { MODULE_MARKER, markSweeping, ONBOARD_MARKER } from "../onboarding/render.ts";
import type { Dropped } from "../onboarding/verify.ts";
import { shortRunId } from "../storage/runStore.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Knowledge candidates (ADR-0020 §6): what a review or the onboarding mapper proposes to add to
 * `.jarvis/`, waiting for a human. Read, promoted and rejected by `jarvis candidates` and by the
 * Modules page of `jarvis ui` through the same functions. Pilot: eight module maps waited as
 * `art_0f1e2d3c4b5a6978`-style rows with a wall of evidence; a candidate now has a name taken from
 * what it is about (`shared-lib/billing`).
 */
export interface CandidateDoc {
  kind: "knowledge" | "standard" | "skill-improvement";
  title: string;
  rationale: string;
  evidence?: string[];
  proposal?: string;
  paths?: string[];
  from?: string;
  status?: string;
  /** Agent-mapped module (onboard --module). */
  module?: string;
  claims?: { proposed: number; kept: number; dropped: number };
  /** Kept claims that generalise beyond their excerpts. */
  review?: string[];
  /** Agent-mapped module: claims the code check dropped, with why. */
  dropped?: Dropped[];
  /** What the person who asked said matters (onboard --note, the page's "What matters"). */
  note?: string;
}

export interface Candidate {
  readonly artifact: ArtifactVersion;
  readonly doc: CandidateDoc;
  readonly decision?: string;
  /** Human handle: unique within all candidates, stable while they exist. */
  readonly name: string;
  readonly claims?: { proposed: number; kept: number; dropped: number };
  readonly review: string[];
  /** Files the evidence quotes, most quoted first. */
  readonly files: string[];
}

/** `module packages/shared-lib/src/billing` → `shared-lib/billing`. */
export function nameOf(doc: Pick<CandidateDoc, "title" | "module" | "kind">): string {
  const module = doc.module ?? /^module\s+(.+)$/.exec(doc.title)?.[1];
  if (module) {
    const parts = module.split("/").filter((p) => p && p !== "src");
    if (parts[0] === "packages" || parts[0] === "apps" || parts[0] === "services" || parts[0] === "libs")
      parts.shift();
    return parts.join("/") || module;
  }
  return doc.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Statements of a rendered module document that generalise (for candidates made before the marker). */
function reviewOf(doc: CandidateDoc): string[] {
  if (doc.review) return doc.review;
  return doc.proposal ? markSweeping(doc.proposal).sweeping : [];
}

/** The document `promote` writes: a module map gets the check markers it may predate. */
export function documentOf(doc: CandidateDoc): string {
  const text = doc.proposal ?? doc.rationale;
  return doc.kind === "knowledge" && (doc.module || /^module\s/.test(doc.title))
    ? markSweeping(text).markdown
    : text;
}

function claimsOf(doc: CandidateDoc): Candidate["claims"] {
  if (doc.claims) return doc.claims;
  const m = /(\d+) of (\d+) claims were confirmed against the code, (\d+) dropped/.exec(doc.rationale);
  return m ? { kept: Number(m[1]), proposed: Number(m[2]), dropped: Number(m[3]) } : undefined;
}

function filesOf(doc: CandidateDoc): string[] {
  const counts = new Map<string, number>();
  for (const e of doc.evidence ?? []) {
    const file = e.replace(/:\d+$/, "");
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);
}

export function candidatesOf(runtime: Runtime, only?: (run: Run) => boolean): Candidate[] {
  const raw: Array<{ artifact: ArtifactVersion; doc: CandidateDoc; decision?: string }> = [];
  // oldest run first (the store lists the latest 100 by default; candidates outlive that)
  const runs = runtime.runs
    .list({ includeTerminal: true, limit: 100_000 })
    .reverse()
    .filter((r) => !only || only(r));
  for (const run of runs) {
    for (const artifact of runtime.artifacts.listLatest(run.id, "candidate")) {
      try {
        const doc = JSON.parse(runtime.artifacts.text(artifact)) as CandidateDoc;
        const decision = runtime.artifacts.approvalsFor(artifact.artifactId, artifact.version)[0]?.decision;
        raw.push({ artifact, doc, ...(decision ? { decision } : {}) });
      } catch {
        // not a candidate document
      }
    }
  }
  // newest first gets the plain name; an older one about the same thing is told apart by its run
  const order = raw
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.artifact.createdAt.localeCompare(a.c.artifact.createdAt) || b.i - a.i);
  // (equal timestamps: the later one in `raw` is the newer one)
  const names = new Map<number, string>();
  const taken = new Set<string>();
  for (const { c, i } of order) {
    let name = nameOf(c.doc);
    if (taken.has(name)) name = `${name}@${shortRunId(c.artifact.runId)}`;
    taken.add(name);
    names.set(i, name);
  }
  // listed oldest first: the newest lands next to the prompt
  return raw
    .map((c, i) => {
      const claims = claimsOf(c.doc);
      const name = names.get(i) ?? nameOf(c.doc);
      return { ...c, name, ...(claims ? { claims } : {}), review: reviewOf(c.doc), files: filesOf(c.doc) };
    })
    .sort((a, b) => a.artifact.createdAt.localeCompare(b.artifact.createdAt));
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Where `promote` writes, from the kind and the id (`--id`, or one derived from the name). */
export function targetOf(root: string, c: Candidate, id: string | undefined): string {
  const fileId =
    id ??
    (c.doc.module || /^module\s/.test(c.doc.title)
      ? `module-${slug(c.name.replace(/@.*$/, ""))}`
      : slug(c.doc.title));
  if (c.doc.kind === "standard") return join(root, ".jarvis", "standards", `${fileId}.md`);
  if (c.doc.kind === "knowledge") return join(root, ".jarvis", "knowledge", `${fileId}.md`);
  return join(root, ".jarvis", "skills", fileId, "IMPROVEMENT.md");
}

/** A file `promote` may replace without asking: one jarvis wrote and nobody took over (the marker is there). */
export function isGenerated(text: string): boolean {
  return text.includes(MODULE_MARKER) || text.includes(ONBOARD_MARKER);
}

/** What is at the target already: nothing, a generated file (replaced), or a person's (needs `replace`). */
export function existingAt(file: string): { readonly text: string; readonly generated: boolean } | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  return { text, generated: isGenerated(text) };
}

/** The target holds a document a person wrote: promote replaces it only when told to. */
export class CandidateTargetTaken extends Error {
  readonly file: string;
  constructor(file: string) {
    super(`${file} already exists and was written by a person; replace it explicitly or choose another id`);
    this.name = "CandidateTargetTaken";
    this.file = file;
  }
}

/** The content `promote` writes for a candidate. */
export function contentOf(c: Candidate, id: string): string {
  const { doc, artifact } = c;
  const source = `${artifact.artifactId}@${artifact.version}`;
  if (doc.kind === "standard") {
    const front = stringify({
      id,
      version: 1,
      title: doc.title,
      severity: "recommended",
      verification: { kind: "semantic" },
      source: { kind: "candidate", ref: source },
      tags: [],
    });
    return `---\n${front}---\n${doc.proposal ?? doc.rationale}\n`;
  }
  if (doc.kind === "knowledge") {
    // a ready document (agent-mapped module): keep its front matter, record where it came from
    if (doc.proposal?.startsWith("---\n"))
      return documentOf(doc).replace(/^---\n/, `---\nsource: ${source}\n`);
    const front = stringify({ tags: [], ...(doc.paths ? { paths: doc.paths } : {}), source });
    return `---\n${front}---\n# ${doc.title}\n\n${doc.proposal ?? doc.rationale}\n`;
  }
  return `# ${doc.title}\n\n${doc.rationale}\n\n${doc.proposal ?? ""}\n`;
}

export interface PromoteInput {
  readonly root: string;
  readonly candidate: Candidate;
  readonly actor: Actor;
  /** File id; default derived from the name. */
  readonly id?: string | undefined;
  /** Replace a document a person wrote (a generated one is replaced anyway). */
  readonly replace?: boolean | undefined;
  /** Where the decision was made, for the record. */
  readonly channel?: "cli" | "ui";
  /** How many of the marked generalisations the person said they checked (the page asks for all). */
  readonly checked?: number | undefined;
}

export interface Promoted {
  readonly file: string;
  /** Repository-relative. */
  readonly path: string;
  /** What was there before and got replaced. */
  readonly replaced?: "generated" | "written by a person";
}

/**
 * Writes the candidate into the project (to be committed through the usual review) and records the
 * human decision. A file at the target is replaced when jarvis generated it (the marker is still
 * there); one a person wrote only with `replace`.
 */
export function promoteCandidate(runtime: Runtime, input: PromoteInput): Promoted {
  const c = input.candidate;
  const file = targetOf(input.root, c, input.id);
  const id = file.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
  const before = existingAt(file);
  if (before && !before.generated && !input.replace) throw new CandidateTargetTaken(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contentOf(c, id));
  const replaced: Promoted["replaced"] = before
    ? before.generated
      ? "generated"
      : "written by a person"
    : undefined;
  const path = relative(input.root, file).split("\\").join("/");
  const notes = [
    `promoted to ${path}`,
    replaced ? `replaced a document ${replaced === "generated" ? "jarvis generated" : "a person wrote"}` : "",
    input.checked !== undefined && c.review.length > 0
      ? `${input.checked} of ${c.review.length} generalisations checked`
      : "",
    input.channel ? `from the ${input.channel === "ui" ? "page" : "terminal"}` : "",
  ].filter(Boolean);
  runtime.artifacts.approve({
    runId: c.artifact.runId,
    stepId: c.artifact.stepId ?? "candidates",
    artifactId: c.artifact.artifactId,
    version: c.artifact.version,
    actor: input.actor,
    decision: "approve",
    comment: notes.join("; "),
  });
  runtime.events.emit({
    kind: "knowledge.promoted",
    runId: c.artifact.runId,
    actor: `${input.actor.kind}:${input.actor.id}`,
    payload: { artifact: c.artifact.artifactId, file: path, ...(replaced ? { replaced } : {}) },
  });
  return { file, path, ...(replaced ? { replaced } : {}) };
}

export function rejectCandidate(runtime: Runtime, c: Candidate, actor: Actor, comment?: string): void {
  runtime.artifacts.approve({
    runId: c.artifact.runId,
    stepId: c.artifact.stepId ?? "candidates",
    artifactId: c.artifact.artifactId,
    version: c.artifact.version,
    actor,
    decision: "reject",
    ...(comment ? { comment } : {}),
  });
}

/** Open candidates about a module (newest first). */
export function candidatesForModule(all: readonly Candidate[], module: string): Candidate[] {
  return all.filter((c) => c.doc.module === module).reverse();
}
