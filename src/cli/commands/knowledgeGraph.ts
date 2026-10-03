import { createRuntime } from "../../app/runtime.ts";
import { repoIdOf, updateGraph, verifyGraph } from "../../knowledge/graph/update.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";

/** `jarvis knowledge update [--full]` / `jarvis knowledge status [--verify]` (ADR-0008 §2–3). */
export async function runKnowledgeUpdate(ctx: CliContext, options: { full?: boolean }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const root = loaded.project?.root ?? ctx.cwd;
    const extractors = runtime.capabilities
      .list()
      .map((a) => a.graphExtractor?.())
      .filter((e) => e !== undefined);
    const started = Date.now();
    const result = await updateGraph({
      workspace: root,
      repoId: repoIdOf(root),
      cacheRoot: loaded.home.cacheDir,
      extractors,
      store: runtime.graph,
      ...(options.full ? { noCache: true, force: true } : {}),
    });
    const ms = Date.now() - started;
    runtime.events.emit({
      kind: "graph.update",
      payload: {
        snapshot: result.snapshot.id,
        reused: result.reused,
        extracted: result.extracted,
        cacheHits: result.cacheHits,
        ms,
      },
    });
    const summary = {
      snapshot: result.snapshot.id,
      treeSha: result.snapshot.treeSha,
      branch: result.snapshot.branch,
      reused: result.reused,
      files: result.snapshot.files,
      extracted: result.extracted,
      cacheHits: result.cacheHits,
      skipped: result.skipped,
      nodes: result.snapshot.nodes.length,
      edges: result.snapshot.edges.length,
      contentHash: result.snapshot.contentHash,
      ms,
    };
    ctx.out.result(summary, () => {
      ctx.out.line(
        result.reused
          ? `graph up to date: snapshot ${summary.snapshot} for tree ${summary.treeSha.slice(0, 10)} (${summary.nodes} nodes, ${summary.edges} edges)`
          : `graph updated: ${summary.files} file(s), ${summary.extracted} extracted, ${summary.cacheHits} from cache, ${summary.nodes} nodes, ${summary.edges} edges in ${ms} ms`,
      );
    });
  } finally {
    await runtime.close();
  }
}

export async function runKnowledgeStatus(ctx: CliContext, options: { verify?: boolean }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const root = loaded.project?.root ?? ctx.cwd;
    const repoId = repoIdOf(root);
    const latest = runtime.graph.latest(repoId);
    let verify: { ok: boolean; stored?: string; recomputed: string } | undefined;
    if (options.verify) {
      const extractors = runtime.capabilities
        .list()
        .map((a) => a.graphExtractor?.())
        .filter((e) => e !== undefined);
      verify = await verifyGraph({
        workspace: root,
        repoId,
        cacheRoot: loaded.home.cacheDir,
        extractors,
        store: runtime.graph,
      });
    }
    ctx.out.result({ repoId, latest: latest ?? null, ...(verify ? { verify } : {}) }, () => {
      if (!latest) {
        ctx.out.line("no graph snapshot yet — run `jarvis knowledge update`");
        return;
      }
      ctx.out.line(
        `snapshot ${latest.id}  tree ${latest.treeSha.slice(0, 10)}${latest.branch ? ` (${latest.branch})` : ""}  ${latest.files} file(s), ${latest.cacheHits} from cache  hash ${latest.contentHash}  ${latest.createdAt}`,
      );
      if (verify)
        ctx.out.line(
          verify.ok
            ? `verify: deterministic (recomputed ${verify.recomputed})`
            : `verify: MISMATCH stored ${verify.stored ?? "-"} vs recomputed ${verify.recomputed}`,
        );
    });
    if (verify && !verify.ok) throw new CliExit(EXIT.error);
  } finally {
    await runtime.close();
  }
}
