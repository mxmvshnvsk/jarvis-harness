import { kilo } from "../../app/activity.ts";
import { duration } from "../../app/journey.ts";
import { modelStats } from "../../app/modelStats.ts";
import { createRuntime } from "../../app/runtime.ts";
import { ModelError } from "../../models/errors.ts";
import { type ProbeResult, probeDrift, probeIsStale, probeModel } from "../../models/probe.ts";
import { structuredModeOf } from "../../models/router.ts";
import { modelAllowed } from "../../security/policy/egress.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";
import { parseSince } from "./logs.ts";

interface ModelRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly egress: string;
  readonly allowed: boolean;
  readonly pool: string;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly structured: string;
  readonly tools: boolean;
  readonly roles: string[];
  readonly probe?: { at: string; stale: boolean; drift: string[] };
  readonly window?: {
    outputTokens: number;
    limit?: number;
    requests: number;
    requestLimit?: number;
    resetsIn: string;
  };
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return m > 0 ? `${m}m${s.toString().padStart(2, "0")}s` : `${s}s`;
}

export async function runModelsList(ctx: CliContext): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const rows: ModelRow[] = Object.entries(loaded.config.models).map(([id, model]) => {
      const roles = Object.entries(loaded.config.roles)
        .filter(([, r]) => r.models.includes(id))
        .map(([name]) => name);
      const probe = runtime.probes.get(id);
      const pool = model.quotaPool ?? `model:${id}`;
      const usage = runtime.budget.windowUsage(pool);
      const definition = runtime.budget.pool(pool);
      return {
        id,
        provider: model.provider,
        model: model.model,
        egress: model.egress,
        allowed: modelAllowed(loaded.config.dataClass, model.egress),
        pool,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        structured: structuredModeOf(model),
        tools: model.supports.tools,
        roles,
        ...(probe
          ? {
              probe: {
                at: probe.probedAt,
                stale: probeIsStale(probe),
                drift: probeDrift(model, probe).map(
                  (d) => `${d.capability}: config ${d.configured} / probe ${d.probed}`,
                ),
              },
            }
          : {}),
        ...(usage && definition
          ? {
              window: {
                outputTokens: usage.outputTokens,
                ...(definition.limits.outputTokens !== undefined
                  ? { limit: definition.limits.outputTokens }
                  : {}),
                requests: usage.requests,
                ...(definition.limits.requests !== undefined
                  ? { requestLimit: definition.limits.requests }
                  : {}),
                resetsIn: fmtDuration(
                  usage.windowEnd.getTime() + definition.window.minutes * 60_000 - Date.now(),
                ),
              },
            }
          : {}),
      };
    });
    ctx.out.result({ dataClass: loaded.config.dataClass, models: rows }, () => {
      if (rows.length === 0) {
        ctx.out.line("no models configured — add one to ~/.jarvis/config.yaml (ADR-0017 §2)");
        return;
      }
      ctx.out.line(`dataClass: ${loaded.config.dataClass}`);
      ctx.out.line();
      const w = Math.max(...rows.map((r) => r.id.length), 5);
      ctx.out.line(
        `${padEnd("model", w)}  ${padEnd("provider", 17)}  ${padEnd("egress", 8)}  ${padEnd("pool", 14)}  ctx/out        structured  tools  roles`,
      );
      for (const r of rows) {
        const egress = r.allowed ? r.egress : `${r.egress}✗`;
        ctx.out.line(
          `${padEnd(r.id, w)}  ${padEnd(r.provider, 17)}  ${padEnd(egress, 8)}  ${padEnd(r.pool, 14)}  ${padEnd(`${r.contextWindow}/${r.maxOutput}`, 13)}  ${padEnd(r.structured, 10)}  ${padEnd(r.tools ? "yes" : "no", 5)}  ${r.roles.join(",") || "-"}`,
        );
        if (r.window) {
          const limit = r.window.limit !== undefined ? `/${r.window.limit}` : "";
          const rl = r.window.requestLimit !== undefined ? `/${r.window.requestLimit}` : "";
          ctx.out.line(
            `${" ".repeat(w)}  window: ${r.window.outputTokens}${limit} output tokens, ${r.window.requests}${rl} requests`,
          );
        }
        if (r.probe) {
          const drift = r.probe.drift.length > 0 ? ` DRIFT ${r.probe.drift.join("; ")}` : "";
          ctx.out.line(
            `${" ".repeat(w)}  probe: ${r.probe.at.slice(0, 10)}${r.probe.stale ? " (stale)" : ""}${drift}`,
          );
        } else {
          ctx.out.line(`${" ".repeat(w)}  probe: never — run \`jarvis models probe ${r.id}\``);
        }
      }
    });
  } finally {
    await runtime.close();
  }
}

export async function runModelsProbe(ctx: CliContext, modelId: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const model = loaded.config.models[modelId];
  if (!model) {
    ctx.out.error(`unknown model "${modelId}"; see \`jarvis models list\``);
    throw new CliExit(EXIT.error);
  }
  if (!modelAllowed(loaded.config.dataClass, model.egress)) {
    ctx.out.error(
      `model "${modelId}" has egress ${model.egress}, not allowed for dataClass ${loaded.config.dataClass}; probe refused (ADR-0016 §3)`,
    );
    throw new CliExit(EXIT.policyDenied);
  }
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    let result: ProbeResult;
    try {
      result = await probeModel(runtime.gateway, modelId);
    } catch (error) {
      if (error instanceof ModelError) {
        ctx.out.error(error.message);
        throw new CliExit(error.kind === "quota_exhausted" ? EXIT.waitingBudget : EXIT.error);
      }
      throw error;
    }
    const path = runtime.probes.set(result);
    const drift = probeDrift(model, result);
    ctx.out.result({ ...result, drift, path }, () => {
      ctx.out.line(
        `model ${modelId} (${model.model}) probed in ${result.latencyMs} ms, ${result.outputTokens} output tokens`,
      );
      const undecided = new Set<string>(result.inconclusive ?? []);
      for (const [k, v] of Object.entries(result.supports)) {
        const err = result.errors[k] ? `  — ${result.errors[k]}` : "";
        ctx.out.line(`  ${padEnd(k, 11)} ${undecided.has(k) ? "?  " : v ? "yes" : "no "}${err}`);
      }
      if (drift.length > 0) {
        ctx.out.line();
        ctx.out.line("drift against configuration:");
        for (const d of drift)
          ctx.out.line(`  ${d.capability}: config says ${d.configured}, probe says ${d.probed}`);
      }
      ctx.out.line(`saved: ${path}`);
    });
  } finally {
    await runtime.close();
  }
}

const kTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : kilo(n));

/**
 * `jarvis models stats [modelId] [--since 24h]` — how the models behave, from the event journal:
 * answered and failed requests, retries, latency, output speed, tokens, why requests fail and how
 * long the failed attempts ran.
 */
export async function runModelsStats(
  ctx: CliContext,
  modelId: string | undefined,
  options: { since?: string },
): Promise<void> {
  const window = options.since ?? "24h";
  const ms = parseSince(window);
  if (ms === undefined) {
    ctx.out.error(`cannot read --since "${window}" (examples: 30m, 2h, 1d)`);
    throw new CliExit(EXIT.error);
  }
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const since = new Date(Date.now() - ms).toISOString();
    const events = ["model.call", "model.retry", "model.error"].flatMap((kind) =>
      runtime.events.list({ kind, since, limit: 100_000 }),
    );
    const stats = modelStats(events).filter((s) => !modelId || s.modelId === modelId);
    ctx.out.result({ since, models: stats }, () => {
      const st = ctx.out.style;
      if (stats.length === 0) {
        ctx.out.line(`no model calls in the last ${window}${modelId ? ` for ${modelId}` : ""}`);
        return;
      }
      const f = (label: string) => `  ${st.muted(padEnd(label, 10))} `;
      const p = (v: { p50: number; p90: number; max: number }, unit: (n: number) => string) =>
        `p50 ${unit(v.p50)} ${st.muted("·")} p90 ${unit(v.p90)} ${st.muted("·")} max ${unit(v.max)}`;
      for (const s of stats) {
        const cfg = loaded.config.models[s.modelId];
        const rate = `${Math.round(s.successRate * 1000) / 10}%`;
        ctx.out.line(
          `${st.name(s.modelId)}  ${st.muted(`last ${window} ·`)} ${s.calls} answered, ${s.failed > 0 ? st.bad(`${s.failed} failed`) : "0 failed"} ${st.muted(`(${rate})`)}${s.retries > 0 ? ` ${st.muted("·")} ${st.warn(`${s.retries} retries`)}` : ""}`,
        );
        if (s.latencyMs)
          ctx.out.line(
            `${f("latency")}${p(s.latencyMs, duration)}${cfg ? st.muted(`   timeout ${duration(cfg.timeoutMs)}`) : ""}`,
          );
        if (s.outputPerSecond)
          ctx.out.line(`${f("speed")}${p(s.outputPerSecond, (n) => `${Math.round(n)} tok/s`)}`);
        if (s.streamed)
          ctx.out.line(
            `${f("streamed")}${s.streamed.calls} of ${s.calls}${s.streamed.firstTokenMs ? `${st.muted(" · first token ")}${p(s.streamed.firstTokenMs, duration)}` : ""}`,
          );
        ctx.out.line(
          `${f("prompt")}avg ${kTok(s.promptTokens.avg)} ${st.muted("·")} max ${kTok(s.promptTokens.max)} ${st.muted("·")} total ${kTok(s.promptTokens.total)} ${st.muted(`· cached ${Math.round(s.cachedShare * 100)}%`)}`,
        );
        ctx.out.line(
          `${f("output")}avg ${kTok(s.outputTokens.avg)} ${st.muted("·")} max ${kTok(s.outputTokens.max)} ${st.muted("·")} total ${kTok(s.outputTokens.total)}`,
        );
        const finish = Object.entries(s.finishReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => (r === "length" ? st.warn(`${r} ${n} (cut at maxOutput)`) : `${r} ${n}`));
        ctx.out.line(`${f("finish")}${finish.join(st.muted(" · "))}`);
        if (s.failures.length > 0) {
          ctx.out.line(`${f("failures")}`);
          for (const g of s.failures) {
            const counts = [
              g.retries > 0 ? `${g.retries} retried` : "",
              g.failed > 0 ? st.bad(`${g.failed} gave up`) : "",
            ]
              .filter(Boolean)
              .join(", ");
            // the same attempt length every time: something cuts requests off at that point
            const same =
              g.attemptMs && g.attemptMs.max - g.attemptMs.p50 <= Math.max(2000, g.attemptMs.p50 * 0.02);
            const attempt = g.attemptMs
              ? same && g.retries + g.failed > 1
                ? st.warn(`every attempt ran ${duration(g.attemptMs.p50)} — a cut-off, not the model`)
                : st.muted(`attempts p50 ${duration(g.attemptMs.p50)}, max ${duration(g.attemptMs.max)}`)
              : "";
            ctx.out.line(
              `    ${st.warn("⚠")} ${g.reason}  ${counts}  ${attempt}  ${st.muted(`last ${g.last.slice(5, 16).replace("T", " ")}`)}`,
            );
          }
        }
        const w = Math.max(...s.byAgent.map((a) => a.agent.length));
        s.byAgent.slice(0, 8).forEach((a, i) => {
          ctx.out.line(
            `${i === 0 ? f("by agent") : " ".repeat(13)}${padEnd(a.agent, w)}  ${String(a.calls).padStart(4)} calls ${st.muted("·")} p50 ${duration(a.latencyP50)} ${st.muted("·")} prompt avg ${kTok(a.promptAvg)}`,
          );
        });
        ctx.out.line();
      }
    });
  } finally {
    await runtime.close();
  }
}
