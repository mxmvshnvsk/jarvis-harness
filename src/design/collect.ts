import type { DeterministicTool } from "../orchestration/executors.ts";
import { type ContractCheck, checkContracts, contractsSection } from "./contracts.ts";
import { figmaLinksIn } from "./figma.ts";

/** How far the step goes without a model: issues named by the task, their pages, the frames found. */
export const DESIGN_LIMITS = { issues: 3, pages: 6, frames: 8 } as const;

const num = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? Math.floor(v) : fallback);

/** The issue and page texts handed to the agents as they were read, at most this much. */
export const SOURCES_LIMITS = { perSource: 20_000, total: 60_000 } as const;

/**
 * `sources.collect` (step `sources`; `design.collect` is its first name) — the task's inputs, read by
 * code before any agent runs: the issues the task names (`jira.get`), the Confluence pages they link
 * (`confluence.get`, embedded frames included), the API methods they name checked against the project's
 * contract maps (src/design/contracts.ts), every Figma frame link found there (`figma.get`, described by
 * code). Two artifacts the agents get as inputs: `sources` (the issues and pages as read, the methods
 * checked) and `design` (the frames). Every
 * call goes through the Tool Router like an agent's — policy, the egress exception, the journal.
 * Pilot: the research agent read 2 of 7 frames and spent its tool calls deciding which; and with the
 * pages read here only for their links, it read the issue and a page three times each and never
 * opened the page with the API the task needed.
 */
export const collectSources: DeterministicTool = async (ctx, args) => {
  const limits = {
    issues: num(args.maxIssues, DESIGN_LIMITS.issues),
    pages: num(args.maxPages, DESIGN_LIMITS.pages),
    frames: num(args.maxFrames, DESIGN_LIMITS.frames),
  };
  const available = new Set(ctx.tools.list().map((d) => d.name));

  const sources: Array<{ from: string; text: string }> = [{ from: "the task", text: ctx.run.task }];
  const keys = [...new Set(ctx.run.task.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])].slice(0, limits.issues);
  if (available.has("jira.get"))
    for (const key of keys) {
      const r = await ctx.tools.invoke("jira.get", { key });
      if (r.ok) sources.push({ from: `issue ${key}`, text: withoutHead(r.text) });
    }
  const pages = [
    ...new Set(
      sources.flatMap((s) =>
        [...s.text.matchAll(/(?:\/pages\/|pageId=)(\d{4,})/g)].map((m) => m[1] as string),
      ),
    ),
  ].slice(0, limits.pages);
  if (available.has("confluence.get"))
    for (const id of pages) {
      const r = await ctx.tools.invoke("confluence.get", { id });
      if (!r.ok) continue;
      const title = /"title":\s*"([^"]+)"/.exec(r.text)?.[1];
      sources.push({ from: `Confluence ${title ? `«${title}» ` : ""}(${id})`, text: withoutHead(r.text) });
    }
  const outputs: string[] = [];
  const read = sources.slice(1);
  // the API methods they name, checked against the project's contract maps: settled before the agents
  const contracts = checkContracts(ctx.workspace.ref.path, ctx.runtime.loaded.config.contracts, sources);
  if (contracts)
    ctx.runtime.events.emit({
      kind: "sources.contracts",
      runId: ctx.run.id,
      stepId: ctx.step.id,
      iteration: ctx.iteration,
      payload: {
        files: contracts.files,
        mentions: contracts.results.length,
        found: contracts.results.filter((r) => r.matches.length > 0).length,
        ...(contracts.unreadable.length > 0 ? { unreadable: contracts.unreadable } : {}),
      },
    });
  if (read.length > 0 || contracts) {
    const artifact = ctx.runtime.artifacts.put({
      runId: ctx.run.id,
      type: "sources",
      name: "sources.md",
      content: sourcesDoc(read, contracts),
      provenance: { kind: "tool", capability: "sources.collect" },
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
    outputs.push(`${artifact.artifactId}@${artifact.version}`);
  }
  const done = (reason: string) => ({
    status: "success" as const,
    reason,
    ...(outputs.length > 0 ? { outputs } : {}),
  });
  if (!available.has("figma.get")) return done("figma.get is not available here: no design frames read");

  const found: Array<{ link: string; from: string }> = [];
  const seen = new Set<string>();
  for (const s of sources)
    for (const link of figmaLinksIn(s.text)) {
      const id = link.replace(/[?&]t=[^&]*/, "");
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({ link, from: s.from });
    }
  if (found.length === 0) return done("no design frame links in the task, its issues or pages");

  // the task asked for the frames as they are now (a design changed at the same link): past the cache,
  // and what is read replaces the cached frame for the tasks after it
  const fresh = ctx.run.options?.fresh?.includes("design") === true;
  const readFrame = (args: Record<string, unknown>) =>
    ctx.tools.invoke("figma.get", fresh ? { ...args, fresh: true } : args);
  const frames: Array<{ link: string; from: string; text: string }> = [];
  const missed: Array<{ link: string; from: string; why: string }> = [];
  let limited: string | undefined;
  for (const f of found.slice(0, limits.frames)) {
    // the API said "not before": the frames left are not asked for (each ask would be refused too)
    if (limited) {
      missed.push({ ...f, why: limited });
      continue;
    }
    let r = await readFrame({ url: f.link });
    // a whole screen may not fit the time: its upper levels still tell the structure and the texts
    if (!r.ok && /time(d)? ?out/i.test(r.error ?? r.text)) r = await readFrame({ url: f.link, depth: 4 });
    if (r.ok) {
      frames.push({ ...f, text: withoutHead(r.text) });
      continue;
    }
    const message = r.error ?? r.text;
    if (/rate limit/i.test(message)) {
      const until = /before (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(message)?.[1];
      limited = `the Figma API's rate limit${until ? ` until ${until}` : ""}`;
      missed.push({ ...f, why: limited });
    } else missed.push({ ...f, why: (r.denied ?? message ?? "failed").split("\n")[0] ?? "failed" });
  }
  for (const f of found.slice(limits.frames))
    missed.push({ ...f, why: `over the limit of ${limits.frames} frames` });

  const doc = [
    "# Design frames of the task",
    "",
    `Read by Jarvis from the task, its issues and their Confluence pages, without a model: ${frames.length} frame${frames.length === 1 ? "" : "s"} read${fresh ? " again from Figma, past Jarvis's cache" : ""}${missed.length > 0 ? `, ${missed.length} not` : ""}. Texts, layout, components and spacing come from Figma as they are; map them to the code with the project's design-system knowledge — the colours and fonts of the designs may be newer than the code's theme.`,
    ...frames.flatMap((f, i) => [
      "",
      `## ${i + 1}. ${(/^### (.+)$/m.exec(f.text)?.[1] ?? "frame").trim()}`,
      `From ${f.from} · ${f.link}`,
      "",
      f.text.replace(/^### .+\n/, "").trim(),
    ]),
    ...(missed.length > 0
      ? ["", "## Not read", ...missed.map((f) => `- ${f.link} (from ${f.from}) — ${f.why}`)]
      : []),
  ].join("\n");
  const artifact = ctx.runtime.artifacts.put({
    runId: ctx.run.id,
    type: "design",
    name: "design.md",
    content: `${doc}\n`,
    provenance: { kind: "tool", capability: "sources.collect" },
    stepId: ctx.step.id,
    iteration: ctx.iteration,
  });
  return {
    status: "success",
    ...(fresh
      ? {
          reason: `${frames.length} design frame${frames.length === 1 ? "" : "s"} read again from Figma, past the cache`,
        }
      : {}),
    outputs: [...outputs, `${artifact.artifactId}@${artifact.version}`],
  };
};

/** A tool's answer without its `[jira.get] ok` line. */
const withoutHead = (text: string): string => text.replace(/^\[[a-z.]+\] ok\n/, "");

/** The issues and pages as read, in order, each clipped, all within the total. */
function sourcesDoc(read: ReadonlyArray<{ from: string; text: string }>, contracts?: ContractCheck): string {
  let left: number = SOURCES_LIMITS.total;
  const parts = read.map((s) => {
    const room = Math.max(0, Math.min(SOURCES_LIMITS.perSource, left));
    left -= Math.min(s.text.length, room);
    const text =
      s.text.length > room
        ? `${s.text.slice(0, room)}\n… [${s.text.length - room} more chars: ask the tool for the rest]`
        : s.text;
    return `## ${s.from[0]?.toUpperCase()}${s.from.slice(1)}\n\n${text.trim()}`;
  });
  return [
    "# The task's sources",
    "",
    "Read by Jarvis before the agents, without a model: the issues the task names and the Confluence pages they link, as the tools returned them. Quote them by the issue key or the page id; ask jira.get / confluence.get only for what is not here.",
    "",
    parts.join("\n\n"),
    ...(contracts ? ["", contractsSection(contracts)] : []),
    "",
  ].join("\n");
}
