import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import type { Actor } from "../core/domain/actor.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import { layoutOf } from "../core/paths.ts";
import { loadGlossary, parseGlossary } from "../knowledge/retrieval/glossary.ts";
import { type GlossaryProposal, proposeGlossary, termLinksIn } from "../knowledge/retrieval/termLinks.ts";
import { BUILTIN_SKILLS, projectSkillDirOf, type Skill } from "../knowledge/skills.ts";
import { MODULE_MARKER, markSweeping, ONBOARD_MARKER } from "../onboarding/render.ts";
import type { Dropped } from "../onboarding/verify.ts";
import { newRunId, shortRunId } from "../storage/runStore.ts";
import { addGlossaryTerm, extendGlossaryTerm } from "./knowledgeView.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Knowledge candidates (ADR-0020 §6): what a review or the onboarding mapper proposes to add to
 * `.jarvis/`, waiting for a human. Read, promoted and rejected by `jarvis candidates` and by the
 * Modules page of `jarvis ui` through the same functions. Pilot: eight module maps waited as
 * `art_0f1e2d3c4b5a6978`-style rows with a wall of evidence; a candidate now has a name taken from
 * what it is about (`shared-lib/billing`).
 */
export interface CandidateDoc {
  kind: "knowledge" | "standard" | "skill-improvement" | "glossary";
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
  /** skill-improvement: the id of the skill it improves. */
  skill?: string;
  /** A finding review repeated in runs (src/app/repeatedFindings.ts): its key and the runs. */
  finding?: { key: string; runs: string[] };
  /** glossary (ADR-0015 §3): the term and the code symbols a run linked to it. */
  glossary?: GlossaryProposal;
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
    // an artifact ref (a review a repeated finding came from) is not a file
    if (/^art_[0-9a-f]+@\d+$/.test(e)) continue;
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

function slug(text: string, max = 48): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Longest file id of a module map before it is shortened with a hash of the whole name. */
const MODULE_ID_MAX = 96;

/**
 * A module map's file id: the whole name, so two folders never share one and the name says which
 * folder it is; a very long one keeps its start and a hash of the rest (pilot: 48 characters cut
 * `…-container-online-bank-account-docs-presign` to `…-container-online-bank-`).
 */
export function moduleFileId(name: string): string {
  const full = slug(name, Number.MAX_SAFE_INTEGER);
  if (full.length <= MODULE_ID_MAX) return `module-${full}`;
  const hash = createHash("sha1").update(full).digest("hex").slice(0, 6);
  return `module-${full.slice(0, MODULE_ID_MAX - 7).replace(/-+$/, "")}-${hash}`;
}

/** Where `promote` writes, from the kind and the id (`--id`, or one derived from the name). */
export function targetOf(root: string, c: Candidate, id: string | undefined): string {
  const fileId =
    id ??
    (c.doc.module || /^module\s/.test(c.doc.title)
      ? moduleFileId(c.name.replace(/@.*$/, ""))
      : slug(c.doc.title));
  const layout = layoutOf(root);
  if (c.doc.kind === "glossary") return layout.glossaryFile;
  if (c.doc.kind === "standard") return join(layout.jarvisDir, "standards", `${fileId}.md`);
  // a service's knowledge goes to its folder of the knowledge repository (ADR-0025 §1)
  if (c.doc.kind === "knowledge") return join(layout.knowledgeDir, `${fileId}.md`);
  // a skill improvement edits that skill's instructions (skillEditOf)
  return c.doc.skill
    ? join(projectSkillDirOf(root, c.doc.skill), "instructions.md")
    : join(layout.jarvisDir, "skills", fileId, "instructions.md");
}

/** A candidate that cannot be written where it would go (a skill improvement without its skill). */
export class CandidateNotPromotable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateNotPromotable";
  }
}

/** What accepting a skill improvement does to the skill: its instructions before and after, its version. */
export interface SkillEdit {
  readonly skill: string;
  readonly dir: string;
  readonly instructions: string;
  readonly before: string;
  readonly after: string;
  readonly version: { readonly from: number; readonly to: number };
  /** A built-in skill: written into the project as a copy that overrides it from now on. */
  readonly fromBuiltin: boolean;
}

/**
 * A skill improvement as an edit of the skill (ADR-0020 §6): its proposal goes at the end of the skill's
 * `instructions.md` and the version goes up, so a run's provenance (`skill:id@v`) tells which text an
 * agent had. A built-in skill is copied into `.jarvis/skills/<id>/` first; a skill read from the team's
 * documentation or `~/.jarvis/skills` is not this project's to change. Pilot: the improvement went to
 * `.jarvis/skills/<title>/IMPROVEMENT.md`, which no agent ever read.
 */
export function skillEditOf(root: string, doc: CandidateDoc): SkillEdit {
  if (!doc.skill)
    throw new CandidateNotPromotable(
      "this skill improvement names no skill (proposed before improvements named theirs): reject it; review proposes it again",
    );
  const dir = projectSkillDirOf(root, doc.skill);
  const instructions = join(dir, "instructions.md");
  const addition = (doc.proposal ?? doc.rationale).trim();
  const edit = (before: string, from: number, fromBuiltin: boolean): SkillEdit => ({
    skill: doc.skill as string,
    dir,
    instructions,
    before,
    after: `${before.trimEnd()}\n\n${addition}\n`,
    version: { from, to: from + 1 },
    fromBuiltin,
  });
  if (existsSync(join(dir, "skill.yaml"))) {
    const manifest = parse(readFileSync(join(dir, "skill.yaml"), "utf8")) as { version?: unknown } | null;
    const from = typeof manifest?.version === "number" ? manifest.version : 1;
    return edit(existsSync(instructions) ? readFileSync(instructions, "utf8") : "", from, false);
  }
  const builtin = BUILTIN_SKILLS.find((s) => s.id === doc.skill);
  if (builtin) return edit(builtin.instructions, builtin.version, true);
  throw new CandidateNotPromotable(
    `skill "${doc.skill}" is not one of this project's skills: change it where it lives (the team's documentation, ~/.jarvis/skills)`,
  );
}

/** Writes the edit: the instructions, and the manifest with the new version (a built-in's, copied). */
function writeSkillEdit(e: SkillEdit): void {
  mkdirSync(e.dir, { recursive: true });
  writeFileSync(e.instructions, e.after);
  const manifestFile = join(e.dir, "skill.yaml");
  if (e.fromBuiltin) {
    const {
      instructions: _i,
      level: _l,
      dir: _d,
      source: _s,
      ...manifest
    } = BUILTIN_SKILLS.find((s) => s.id === e.skill) as Skill;
    writeFileSync(manifestFile, stringify({ ...manifest, version: e.version.to }));
    return;
  }
  // the person's file: only the version changes, comments and order stay
  const doc = parseDocument(readFileSync(manifestFile, "utf8"));
  doc.set("version", e.version.to);
  writeFileSync(manifestFile, doc.toString());
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

/**
 * The document already in the knowledge folder about the same module (its `paths` is the module's
 * folder), under whatever name: a new map of the module replaces it instead of lying next to it
 * (pilot: names cut at 48 characters, then a longer name for the same folder — two documents).
 */
export function sameModuleDoc(dir: string, module: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const want = `${module.replace(/\/+$/, "")}/**`;
  for (const name of readdirSync(dir)) {
    if (!/^module-.*\.md$/.test(name)) continue;
    const file = join(dir, name);
    const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1];
    if (!head) continue;
    try {
      const paths = (parse(head) as { paths?: unknown } | null)?.paths;
      if (Array.isArray(paths) && paths.length === 1 && paths[0] === want) return file;
    } catch {
      // a broken front matter is not this module's document
    }
  }
  return undefined;
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
  /** The same module's document it replaced under another name (repository-relative): removed. */
  readonly renamedFrom?: string;
  /** A skill improvement: the skill edited, its version before and after. */
  readonly skill?: {
    readonly id: string;
    readonly from: number;
    readonly to: number;
    readonly fromBuiltin: boolean;
  };
}

/**
 * Writes the candidate into the project (to be committed through the usual review) and records the
 * human decision. A file at the target is replaced when jarvis generated it (the marker is still
 * there); one a person wrote only with `replace`.
 */
export function promoteCandidate(runtime: Runtime, input: PromoteInput): Promoted {
  const c = input.candidate;
  if (c.doc.kind === "skill-improvement") return promoteSkillEdit(runtime, input);
  if (c.doc.kind === "glossary") return promoteGlossary(runtime, input);
  const file = targetOf(input.root, c, input.id);
  const id = file.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
  // the same module's document under another name: replaced, and its file goes
  const old =
    c.doc.kind === "knowledge" && c.doc.module && !input.id
      ? sameModuleDoc(dirname(file), c.doc.module)
      : undefined;
  const renamed = old && old !== file ? old : undefined;
  const before = existingAt(file) ?? (renamed ? existingAt(renamed) : undefined);
  if (before && !before.generated && !input.replace) throw new CandidateTargetTaken(renamed ?? file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contentOf(c, id));
  if (renamed && existsSync(renamed)) unlinkSync(renamed);
  const replaced: Promoted["replaced"] = before
    ? before.generated
      ? "generated"
      : "written by a person"
    : undefined;
  const path = relative(input.root, file).split("\\").join("/");
  const notes = [
    `promoted to ${path}`,
    replaced ? `replaced a document ${replaced === "generated" ? "jarvis generated" : "a person wrote"}` : "",
    renamed ? `in place of ${relative(input.root, renamed).split("\\").join("/")}` : "",
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
  return {
    file,
    path,
    ...(replaced ? { replaced } : {}),
    ...(renamed ? { renamedFrom: relative(input.root, renamed).split("\\").join("/") } : {}),
  };
}

function promoteSkillEdit(runtime: Runtime, input: PromoteInput): Promoted {
  const c = input.candidate;
  const e = skillEditOf(input.root, c.doc);
  writeSkillEdit(e);
  const path = relative(input.root, e.instructions).split("\\").join("/");
  const notes = [
    `skill ${e.skill} v${e.version.from} → v${e.version.to}${e.fromBuiltin ? " (the built-in, now overridden by the project's copy)" : ""}`,
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
    payload: { artifact: c.artifact.artifactId, file: path, skill: e.skill, version: e.version.to },
  });
  return { file: e.instructions, path, skill: { id: e.skill, ...e.version, fromBuiltin: e.fromBuiltin } };
}

/** Accepting a glossary candidate: a new row for a new term, the new symbols added to a known one's row. */
function promoteGlossary(runtime: Runtime, input: PromoteInput): Promoted {
  const c = input.candidate;
  const g = c.doc.glossary;
  if (!g) throw new CandidateNotPromotable("this glossary candidate carries no term");
  const file = layoutOf(input.root).glossaryFile;
  const known = parseGlossary(existsSync(file) ? readFileSync(file, "utf8") : "").some(
    (e) => e.term.toLowerCase() === g.term.toLowerCase(),
  );
  if (known) extendGlossaryTerm(input.root, g.term, g.symbols);
  else addGlossaryTerm(input.root, { term: g.term, synonyms: [], symbols: g.symbols, sources: g.sources });
  const path = relative(input.root, file).split("\\").join("/");
  runtime.artifacts.approve({
    runId: c.artifact.runId,
    stepId: c.artifact.stepId ?? "candidates",
    artifactId: c.artifact.artifactId,
    version: c.artifact.version,
    actor: input.actor,
    decision: "approve",
    comment: [
      `${known ? "added symbols to" : "added"} «${g.term}» in ${path}`,
      input.channel ? `from the ${input.channel === "ui" ? "page" : "terminal"}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  });
  runtime.events.emit({
    kind: "knowledge.promoted",
    runId: c.artifact.runId,
    actor: `${input.actor.kind}:${input.actor.id}`,
    payload: { artifact: c.artifact.artifactId, file: path, term: g.term },
  });
  return { file, path };
}

/** The newest version a person edited of each artifact of these types, else the latest. */
function preferredVersions(runtime: Runtime, runId: string, types: readonly string[]): ArtifactVersion[] {
  return types.flatMap((type) =>
    runtime.artifacts.listLatest(runId, type).map((latest) => {
      const versions = runtime.artifacts.versions(latest.artifactId);
      return [...versions].reverse().find((v) => v.provenance.kind === "human") ?? latest;
    }),
  );
}

/**
 * ADR-0015 §3: after a completed run, the terms its research and impact linked to code become
 * glossary candidates — one per term, only symbols the glossary lacks, none proposed (or decided)
 * before. Deterministic, no model call; a person accepts them with `jarvis candidates promote`.
 */
export function proposeGlossaryCandidates(runtime: Runtime, run: Run): ArtifactVersion[] {
  const artifacts = preferredVersions(runtime, run.id, ["research", "impact"]).map((a) => ({
    ref: `${a.artifactId}@${a.version}`,
    human: a.provenance.kind === "human",
    termLinks: termLinksIn(runtime.artifacts.text(a)),
  }));
  if (artifacts.every((a) => a.termLinks.length === 0)) return [];
  const proposals = proposeGlossary(artifacts, loadGlossary(run.workspace.repoRoot));
  // a term with these symbols proposed before (open, accepted or declined) is not proposed again
  const seen = new Set(
    candidatesOf(runtime)
      .filter((c) => c.doc.kind === "glossary" && c.doc.glossary)
      .flatMap((c) =>
        (c.doc.glossary as GlossaryProposal).symbols.map(
          (s) => `${c.doc.glossary?.term.toLowerCase()}\0${s}`,
        ),
      ),
  );
  const out: ArtifactVersion[] = [];
  proposals.forEach((p) => {
    const symbols = p.symbols.filter((s) => !seen.has(`${p.term.toLowerCase()}\0${s}`));
    if (symbols.length === 0) return;
    const g: GlossaryProposal = { ...p, symbols };
    const doc: CandidateDoc = {
      kind: "glossary",
      title: `glossary ${p.term}`,
      rationale: `${p.existing ? `«${p.term}» is in the glossary without` : `«${p.term}» is not in the glossary; the run linked it to`} ${symbols.join(", ")} (${p.from.join(", ")})`,
      proposal: `| ${p.term} |  | ${symbols.map((s) => `\`${s}\``).join(", ")} | ${p.sources.join(", ")} |`,
      evidence: p.sources,
      from: p.from.join(", "),
      status: "proposed",
      glossary: g,
    };
    out.push(
      runtime.artifacts.put({
        runId: run.id,
        type: "candidate",
        name: `glossary-${out.length + 1}.json`,
        content: JSON.stringify(doc, null, 2),
        mediaType: "application/json",
        provenance: { kind: "tool", capability: "glossary.termLinks" },
        sourceRefs: p.from,
        stepId: "glossary",
      }),
    );
  });
  if (out.length > 0)
    runtime.events.emit({
      kind: "glossary.proposed",
      runId: run.id,
      payload: { terms: out.length },
    });
  return out;
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

/**
 * The run that holds the candidates no step of a run made: proposed by hand (`jarvis candidates add`),
 * found by review in several runs (src/app/repeatedFindings.ts). One per repository, made the first
 * time and ended at once — nothing to execute; a candidate is an artifact of a run like any other, so
 * list, show, promote and reject need nothing new.
 */
export const CANDIDATES_WORKFLOW = "candidates";

export function candidatesRunOf(runtime: Runtime, root: string, owner: Actor): Run {
  const found = runtime.runs
    .list({ includeTerminal: true, limit: 100_000 })
    .find((r) => r.workflow === CANDIDATES_WORKFLOW && r.workspace.repoRoot === root);
  if (found) return found;
  const run = runtime.runs.create({
    id: newRunId(),
    task: "Knowledge candidates proposed outside a run's steps",
    workflow: CANDIDATES_WORKFLOW,
    owner,
    workspace: { mode: "cwd", repoRoot: root, path: root, baseRef: "HEAD" },
    dataClass: runtime.loaded.config.dataClass,
    ...(runtime.loaded.config.profile ? { profile: runtime.loaded.config.profile } : {}),
  });
  runtime.events.emit({
    kind: "run.created",
    runId: run.id,
    actor: `${owner.kind}:${owner.id}`,
    payload: { task: run.task, workflow: CANDIDATES_WORKFLOW, trigger: "candidates" },
  });
  runtime.runs.transition(run.id, "RUNNING", { reason: "holds candidates" });
  return runtime.runs.transition(run.id, "COMPLETED", { reason: "holds candidates; nothing to execute" });
}

/** A candidate that cannot be proposed as given (no title, no text, a skill there is not). */
export class CandidateInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateInvalid";
  }
}

export interface AddCandidateInput {
  readonly root: string;
  readonly actor: Actor;
  readonly kind: CandidateDoc["kind"];
  readonly title: string;
  /** The rule, the knowledge, or what to add to the skill's instructions. */
  readonly text: string;
  /** Why; a person proposing by hand need not say. */
  readonly rationale?: string | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly evidence?: readonly string[] | undefined;
  /** skill-improvement: the skill it improves. */
  readonly skill?: string | undefined;
  /** The ids of the skills there are (a skill improvement must name one of them). */
  readonly skills?: readonly string[];
  readonly channel?: "cli" | "ui";
}

/**
 * A person proposes a candidate (ADR-0020 §6): the same `candidate` artifact an agent proposes, in the
 * repository's candidates run, decided the same way. A skill improvement must name a skill this
 * project can edit, as promote does; one it could not promote is refused now, not later.
 */
export function addCandidate(runtime: Runtime, input: AddCandidateInput): Candidate {
  const title = input.title.trim();
  const text = input.text.trim();
  if (!title) throw new CandidateInvalid("a candidate needs a title");
  if (!text)
    throw new CandidateInvalid("a candidate needs its text: the rule, the knowledge or the step to add");
  const doc: CandidateDoc = {
    kind: input.kind,
    title,
    rationale: input.rationale?.trim() || `Proposed by ${input.actor.id}`,
    proposal: text,
    ...(input.paths && input.paths.length > 0 ? { paths: [...input.paths] } : {}),
    ...(input.evidence && input.evidence.length > 0 ? { evidence: [...input.evidence] } : {}),
    status: "proposed",
  };
  if (input.kind === "skill-improvement") {
    const skill = input.skill?.trim();
    if (!skill) throw new CandidateInvalid("a skill improvement needs --skill <id>: the skill it improves");
    if (input.skills && !input.skills.includes(skill))
      throw new CandidateInvalid(`no skill "${skill}" (see \`jarvis skills list\`)`);
    doc.skill = skill;
    try {
      skillEditOf(input.root, doc);
    } catch (error) {
      if (error instanceof CandidateNotPromotable) throw new CandidateInvalid(error.message);
      throw error;
    }
  }
  const run = candidatesRunOf(runtime, input.root, input.actor);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const artifact = runtime.artifacts.put({
    runId: run.id,
    type: "candidate",
    name: `by-hand-${slug(title) || "candidate"}-${stamp}.json`,
    content: JSON.stringify(doc, null, 2),
    mediaType: "application/json",
    provenance: { kind: "human", actor: input.actor },
    sourceRefs: [...(input.evidence ?? [])],
    stepId: "candidates",
  });
  runtime.events.emit({
    kind: "candidate.added",
    runId: run.id,
    actor: `${input.actor.kind}:${input.actor.id}`,
    payload: {
      artifact: artifact.artifactId,
      kind: doc.kind,
      title,
      ...(doc.skill ? { skill: doc.skill } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    },
  });
  // its name is unique among all the candidates, so it comes from the whole list
  return candidatesOf(runtime).find((c) => c.artifact.artifactId === artifact.artifactId) as Candidate;
}

/** Open candidates about a module (newest first). */
export function candidatesForModule(all: readonly Candidate[], module: string): Candidate[] {
  return all.filter((c) => c.doc.module === module).reverse();
}
