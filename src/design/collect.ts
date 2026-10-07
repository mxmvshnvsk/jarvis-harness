import type { DeterministicTool } from "../orchestration/executors.ts";
import { figmaLinksIn } from "./figma.ts";

/** How far the step goes without a model: issues named by the task, their pages, the frames found. */
export const DESIGN_LIMITS = { issues: 3, pages: 6, frames: 8 } as const;

const num = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? Math.floor(v) : fallback);

/**
 * `design.collect` — the design frames of a task, read by code before any agent runs: the issues the
 * task names (`jira.get`), the Confluence pages they link (`confluence.get`, embedded frames included),
 * every Figma frame link found there (`figma.get`, described by code). The result is the `design`
 * artifact the agents get as an input. Every call goes through the Tool Router like an agent's — policy,
 * the egress exception, the journal. Pilot: the research agent read 2 of 7 frames and spent its tool
 * calls deciding which.
 */
export const collectDesign: DeterministicTool = async (ctx, args) => {
  const limits = {
    issues: num(args.maxIssues, DESIGN_LIMITS.issues),
    pages: num(args.maxPages, DESIGN_LIMITS.pages),
    frames: num(args.maxFrames, DESIGN_LIMITS.frames),
  };
  const available = new Set(ctx.tools.list().map((d) => d.name));
  if (!available.has("figma.get"))
    return { status: "success", reason: "figma.get is not available here: no design frames read" };

  const sources: Array<{ from: string; text: string }> = [{ from: "the task", text: ctx.run.task }];
  const keys = [...new Set(ctx.run.task.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])].slice(0, limits.issues);
  if (available.has("jira.get"))
    for (const key of keys) {
      const r = await ctx.tools.invoke("jira.get", { key });
      if (r.ok) sources.push({ from: `issue ${key}`, text: r.text });
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
      sources.push({ from: `Confluence ${title ? `«${title}» ` : ""}(${id})`, text: r.text });
    }

  const found: Array<{ link: string; from: string }> = [];
  const seen = new Set<string>();
  for (const s of sources)
    for (const link of figmaLinksIn(s.text)) {
      const id = link.replace(/[?&]t=[^&]*/, "");
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({ link, from: s.from });
    }
  if (found.length === 0)
    return { status: "success", reason: "no design frame links in the task, its issues or pages" };

  const read: Array<{ link: string; from: string; text: string }> = [];
  const missed: Array<{ link: string; from: string; why: string }> = [];
  for (const f of found.slice(0, limits.frames)) {
    let r = await ctx.tools.invoke("figma.get", { url: f.link });
    // a whole screen may not fit the time: its upper levels still tell the structure and the texts
    if (!r.ok && /time(d)? ?out/i.test(r.error ?? r.text))
      r = await ctx.tools.invoke("figma.get", { url: f.link, depth: 4 });
    if (r.ok) read.push({ ...f, text: r.text.replace(/^\[figma\.get\] ok\n/, "") });
    else missed.push({ ...f, why: (r.denied ?? r.error ?? "failed").split("\n")[0] ?? "failed" });
  }
  for (const f of found.slice(limits.frames))
    missed.push({ ...f, why: `over the limit of ${limits.frames} frames` });

  const doc = [
    "# Design frames of the task",
    "",
    `Read by Jarvis from the task, its issues and their Confluence pages, without a model: ${read.length} frame${read.length === 1 ? "" : "s"} read${missed.length > 0 ? `, ${missed.length} not` : ""}. Texts, layout, components and spacing come from Figma as they are; map them to the code with the project's design-system knowledge — the colours and fonts of the designs may be newer than the code's theme.`,
    ...read.flatMap((f, i) => [
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
    provenance: { kind: "tool", capability: "design.collect" },
    stepId: ctx.step.id,
    iteration: ctx.iteration,
  });
  return { status: "success", outputs: [`${artifact.artifactId}@${artifact.version}`] };
};
