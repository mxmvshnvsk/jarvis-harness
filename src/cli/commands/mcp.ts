import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  /** Out of the data class's network by the project's exception (ADR-0016 §6): its reason. */
  readonly egressException?: string;
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
    const rows: Row[] = runtime.mcp.provider.reports().map((r) => {
      const byNetwork = networkAllowed(loaded.config.dataClass, r.network);
      const exception = byNetwork ? undefined : loaded.config.egressExceptions.find((e) => e.server === r.id);
      return {
        ...r,
        egressAllowed: byNetwork || exception !== undefined,
        ...(exception ? { egressException: exception.reason } : {}),
        ...(live.has(r.id) ? { live: live.get(r.id) as { ok: boolean; error?: string } } : {}),
      };
    });
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
        const network = r.egressException ? `${r.network}!` : r.egressAllowed ? r.network : `${r.network}✗`;
        const discovered = r.discovered ? `${r.discovered.at.slice(0, 10)} (${r.discovered.count})` : "never";
        ctx.out.line(
          `${padEnd(r.id, w)}  ${padEnd(r.transport, 9)}  ${padEnd(network, 9)}  ${padEnd(r.profile ?? (r.readOnly ? "readOnly" : "-"), 10)}  ${padEnd(discovered, 16)}  ${padEnd(String(r.exposed.length), 7)}  ${padEnd(String(r.denied.length), 6)}  ${padEnd(String(r.unmapped.length), 8)}  ${r.notAllowed.length}`,
        );
        const pad = " ".repeat(w);
        ctx.out.line(`${pad}  ${r.target}${r.auth ? `  auth: ${r.auth}` : ""}`);
        if (r.error) ctx.out.line(`${pad}  ERROR ${r.error}`);
        if (r.egressException)
          ctx.out.line(
            `${pad}  ${ctx.out.style.warn("⚠")} dataClass ${loaded.config.dataClass}, yet goes to the ${r.network} by an exception (reads only): ${r.egressException}`,
          );
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

/** `--arg key=value` as the capability's arguments: true/false become booleans, the rest stays text. */
export function parseCallArgs(pairs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Error(`--arg ${pair}: expected key=value`);
    const value = pair.slice(at + 1);
    out[pair.slice(0, at)] = value === "true" ? true : value === "false" ? false : value;
  }
  return out;
}

/**
 * `jarvis mcp call <capability> [--arg k=v]… [--full] [--out file]` — one read capability called the
 * way an agent's call goes: the same server, tool and arguments, the same policy (allow / deny, the
 * network for the dataClass) and the same redaction; no run, no model. Pilot: "what does Confluence
 * actually give the agent for this page?" took a research run with a debug log to answer.
 */
export async function runMcpCall(
  ctx: CliContext,
  capability: string,
  options: { arg?: readonly string[]; full?: boolean; out?: string },
): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = parseCallArgs(options.arg ?? []);
  } catch (error) {
    ctx.out.error((error as Error).message);
    throw new CliExit(EXIT.error);
  }
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const cap = runtime.registry.get(capability);
    if (cap) {
      const decision = runtime.tools.policy(cap, ["*"]);
      if (!decision.allowed) {
        ctx.out.error(`${capability}: ${decision.reason ?? "denied"}`);
        throw new CliExit(EXIT.policyDenied);
      }
    }
    const started = Date.now();
    let call: Awaited<ReturnType<typeof runtime.mcp.provider.invoke>>;
    try {
      call = await runtime.mcp.provider.invoke(capability, args);
    } catch (error) {
      ctx.out.error(error instanceof Error ? error.message : String(error));
      throw new CliExit(EXIT.error);
    }
    const ms = Date.now() - started;
    const redacted = runtime.redactor.redact(call.result.text);
    const whole = redacted.text;
    const bytes = Buffer.byteLength(whole, "utf8");
    const max = loaded.config.tools.maxOutputBytes;
    const cut = !options.full && bytes > max;
    const shown = cut ? Buffer.from(whole, "utf8").subarray(0, max).toString("utf8") : whole;
    if (options.out)
      writeFileSync(resolve(ctx.cwd, options.out), whole.endsWith("\n") ? whole : `${whole}\n`);
    ctx.out.result(
      {
        capability,
        server: call.serverId,
        tool: call.tool,
        sent: call.sent,
        ok: call.result.ok,
        ms,
        bytes,
        redactions: redacted.count,
        text: whole,
        ...(call.result.structured !== undefined ? { structured: call.result.structured } : {}),
      },
      () => {
        const st = ctx.out.style;
        // the header on stderr: stdout is the answer alone, for grep and files
        ctx.out.note(
          `${call.result.ok ? st.ok("✓") : st.bad("✗")} ${capability} → ${call.serverId} · ${call.tool} · ${ms} ms · ${bytes.toLocaleString("en-US")} bytes${redacted.count > 0 ? ` · ${redacted.count} redacted` : ""}`,
        );
        ctx.out.note(st.muted(`  sent ${JSON.stringify(call.sent)}`));
        ctx.out.line(shown);
        if (cut)
          ctx.out.note(
            st.muted(
              `  … an agent sees the first ${max.toLocaleString("en-US")} bytes (tools.maxOutputBytes); --full or --out <file> for all ${bytes.toLocaleString("en-US")}`,
            ),
          );
        if (options.out) ctx.out.note(st.muted(`  written to ${options.out}`));
      },
    );
    if (!call.result.ok) throw new CliExit(EXIT.error);
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
