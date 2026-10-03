import { createRuntime } from "../../app/runtime.ts";
import type { ServerReport } from "../../mcp/provider.ts";
import { serveStdio } from "../../mcp/server.ts";
import { networkAllowed } from "../../security/policy/egress.ts";
import { packageInfo } from "../../version.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";

interface Row extends ServerReport {
  readonly egressAllowed: boolean;
  readonly live?: { ok: boolean; error?: string };
}

/** `jarvis mcp list [--refresh]` — servers, discovery state, exposed/denied capabilities (ADR-0017 §6). */
export async function runMcpList(ctx: CliContext, options: { refresh?: boolean }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const live = new Map<string, { ok: boolean; error?: string }>();
    if (options.refresh) {
      for (const id of runtime.mcp.pool.serverIds()) {
        try {
          await runtime.mcp.pool.discover(id);
          live.set(id, { ok: true });
        } catch (error) {
          live.set(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      runtime.registry.replace(runtime.mcp.provider);
    }
    const rows: Row[] = runtime.mcp.provider.reports().map((r) => ({
      ...r,
      egressAllowed: networkAllowed(loaded.config.dataClass, r.network),
      ...(live.has(r.id) ? { live: live.get(r.id) as { ok: boolean; error?: string } } : {}),
    }));
    ctx.out.result({ servers: rows }, () => {
      if (rows.length === 0) {
        ctx.out.line(
          "no MCP servers configured (mcp.servers in ~/.jarvis/config.yaml or .jarvis/project.yaml)",
        );
        return;
      }
      const w = Math.max(...rows.map((r) => r.id.length), 6);
      ctx.out.line(
        `${padEnd("server", w)}  ${padEnd("transport", 9)}  ${padEnd("network", 9)}  ${padEnd("profile", 10)}  discovered        exposed  denied  unmapped  not-allowed`,
      );
      for (const r of rows) {
        const network = r.egressAllowed ? r.network : `${r.network}✗`;
        const discovered = r.discovered ? `${r.discovered.at.slice(0, 10)} (${r.discovered.count})` : "never";
        ctx.out.line(
          `${padEnd(r.id, w)}  ${padEnd(r.transport, 9)}  ${padEnd(network, 9)}  ${padEnd(r.profile ?? (r.readOnly ? "readOnly" : "-"), 10)}  ${padEnd(discovered, 16)}  ${padEnd(String(r.exposed.length), 7)}  ${padEnd(String(r.denied.length), 6)}  ${padEnd(String(r.unmapped.length), 8)}  ${r.notAllowed.length}`,
        );
        const pad = " ".repeat(w);
        ctx.out.line(`${pad}  ${r.target}${r.auth ? `  auth: ${r.auth}` : ""}`);
        if (r.error) ctx.out.line(`${pad}  ERROR ${r.error}`);
        if (r.live && !r.live.ok) ctx.out.line(`${pad}  UNAVAILABLE ${r.live.error}`);
        if (r.exposed.length > 0) ctx.out.line(`${pad}  exposed: ${r.exposed.join(", ")}`);
        if (r.unmapped.length > 0)
          ctx.out.line(`${pad}  unmapped (server lacks the tool): ${r.unmapped.join(", ")}`);
        if (r.notAllowed.length > 0)
          ctx.out.line(`${pad}  discovered, not allowed (add to allow): ${r.notAllowed.join(", ")}`);
        if (!r.discovered && !r.profile)
          ctx.out.line(`${pad}  no profile and never discovered — run \`jarvis mcp list --refresh\``);
      }
    });
    if (rows.some((r) => r.live && !r.live.ok)) throw new CliExit(EXIT.error);
  } finally {
    await runtime.close();
  }
}

/** `jarvis mcp serve` — Jarvis as a read-only MCP server on stdio (ADR-0017 §7). */
export async function runMcpServe(ctx: CliContext): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    await serveStdio(runtime, loaded.project?.root, packageInfo().version);
    // The transport owns the process from here: stay alive until stdin closes.
    await new Promise<void>((resolve) => {
      process.stdin.on("end", () => resolve());
      process.stdin.on("close", () => resolve());
    });
  } finally {
    await runtime.close();
  }
}
