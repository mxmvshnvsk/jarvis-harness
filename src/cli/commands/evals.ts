import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { diffResults, runSuite, type SuiteResult } from "../../evals/runner.ts";
import type { CassetteMode } from "../../models/cassette.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";

/** `jarvis evals run|baseline|diff` (ADR-0012 §4–5). Suites live in `evals/<suite>/<case>/`. */
export interface EvalsRunOptions {
  readonly suite: string;
  readonly mode?: string;
  readonly variant?: string[];
  readonly out?: string;
}

function parseVariant(items: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items ?? []) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new CliExit(EXIT.error, `--variant expects key=value, got "${item}"`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

function resultsDir(ctx: CliContext): string {
  return join(ctx.cwd, "evals", "results");
}

function renderSuite(ctx: CliContext, r: SuiteResult): void {
  ctx.out.line(
    `suite ${r.suite} (${r.mode}${
      Object.keys(r.variant).length > 0
        ? `, ${Object.entries(r.variant)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")}`
        : ""
    })`,
  );
  const w = Math.max(...r.cases.map((c) => c.id.length), 4);
  ctx.out.line(
    `${padEnd("case", w)}  ${padEnd("state", 14)}  ok   tests  files  accept  loops  out-tokens  /10k`,
  );
  for (const c of r.cases) {
    const pct = (x: number | undefined) =>
      x === undefined ? "  -  " : `${String(Math.round(x * 100)).padStart(3)}% `;
    ctx.out.line(
      `${padEnd(c.id, w)}  ${padEnd(c.state, 14)}  ${c.success ? "yes" : "no "}  ${c.testsPassed === undefined ? " -  " : c.testsPassed ? "pass" : "FAIL"}   ${pct(c.fileRecall)}  ${pct(c.acceptanceCoverage)}  ${String(c.loops).padStart(5)}  ${String(c.outputTokens).padStart(10)}  ${c.successPer10k}`,
    );
    if (c.error) ctx.out.line(`${" ".repeat(w)}  ${c.error.slice(0, 160)}`);
  }
  const s = r.summary;
  ctx.out.line(
    `summary: ${s.successes}/${s.cases} succeeded (${Math.round(s.successRate * 100)}%), file recall ${Math.round(s.meanFileRecall * 100)}%, acceptance ${Math.round(s.meanAcceptanceCoverage * 100)}%, ${s.outputTokens} output tokens → ${s.successPer10k} successes per 10k`,
  );
}

export async function runEvalsRun(ctx: CliContext, options: EvalsRunOptions): Promise<void> {
  const mode = (options.mode ?? "replay") as CassetteMode;
  if (!["live", "record", "replay"].includes(mode))
    throw new CliExit(EXIT.error, `--mode must be live, record or replay`);
  const suiteDir = resolve(
    ctx.cwd,
    options.suite.includes("/") ? options.suite : join("evals", options.suite),
  );
  const result = await runSuite(suiteDir, {
    homeDir: ctx.homeDir,
    env: ctx.env,
    mode,
    variant: parseVariant(options.variant),
  });
  const file = options.out
    ? resolve(ctx.cwd, options.out)
    : join(resultsDir(ctx), `${result.at.slice(0, 10)}-${result.suite}.json`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  ctx.out.result({ ...result, file }, () => {
    renderSuite(ctx, result);
    ctx.out.line(`written to ${file}`);
  });
  if (result.summary.successes < result.summary.cases) throw new CliExit(EXIT.error);
}

function baselineFile(ctx: CliContext, suite: string): string {
  return join(ctx.cwd, "evals", "baseline", `${basename(suite)}.json`);
}

function latestResult(ctx: CliContext, suite: string): SuiteResult | undefined {
  const dir = resultsDir(ctx);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(`-${basename(suite)}.json`))
    .sort();
  const last = files.at(-1);
  return last ? (JSON.parse(readFileSync(join(dir, last), "utf8")) as SuiteResult) : undefined;
}

export async function runEvalsBaseline(
  ctx: CliContext,
  suite: string,
  options: { from?: string },
): Promise<void> {
  const result = options.from
    ? (JSON.parse(readFileSync(resolve(ctx.cwd, options.from), "utf8")) as SuiteResult)
    : latestResult(ctx, suite);
  if (!result)
    throw new CliExit(
      EXIT.error,
      `no result for suite ${suite}; run \`jarvis evals run --suite ${suite}\` first`,
    );
  const file = baselineFile(ctx, suite);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  ctx.out.result({ baseline: file, at: result.at, summary: result.summary }, () =>
    ctx.out.line(`baseline for ${suite} ← ${result.at} (${file})`),
  );
}

export async function runEvalsDiff(
  ctx: CliContext,
  suite: string,
  options: { tolerance?: number; from?: string },
): Promise<void> {
  const file = baselineFile(ctx, suite);
  if (!existsSync(file))
    throw new CliExit(EXIT.error, `no baseline for ${suite}; run \`jarvis evals baseline ${suite}\``);
  const baseline = JSON.parse(readFileSync(file, "utf8")) as SuiteResult;
  const current = options.from
    ? (JSON.parse(readFileSync(resolve(ctx.cwd, options.from), "utf8")) as SuiteResult)
    : latestResult(ctx, suite);
  if (!current) throw new CliExit(EXIT.error, `no result for ${suite}`);
  const diff = diffResults(baseline, current, options.tolerance ?? 0.05);
  ctx.out.result({ baseline: baseline.at, current: current.at, ...diff }, () => {
    ctx.out.line(`baseline ${baseline.at} vs ${current.at}`);
    for (const [m, d] of Object.entries(diff.deltas))
      ctx.out.line(`  ${padEnd(m, 24)} ${d >= 0 ? "+" : ""}${d}`);
    ctx.out.line(diff.ok ? "no regression beyond tolerance" : `REGRESSION: ${diff.regressions.join("; ")}`);
  });
  if (!diff.ok) throw new CliExit(EXIT.error);
}
