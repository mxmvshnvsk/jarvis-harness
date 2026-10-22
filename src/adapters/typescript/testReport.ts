import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StackFrame, TestFailure, TestReport, TestReporter } from "../../core/capabilities/contracts.ts";
import { expectedActualOf, messageOf } from "../../orchestration/tools/testReport.ts";

/**
 * Why JavaScript tests failed (jest, vitest, mocha): the runner found in the command or behind a
 * package script, its JSON report written beside its usual output, else what it printed.
 */

export type JsRunner = "jest" | "vitest" | "mocha";

export interface JsRunnerOf {
  readonly runner: JsRunner;
  /** Arguments reach the runner only after `--` (an npm script). */
  readonly dashDash: boolean;
}

const RUNNER_WORD = /\b(vitest|jest|mocha)\b/;

/**
 * The JavaScript test runner a `test*` command ends in: named in it (`npx jest`), or behind a package
 * script (`yarn test`, `npm run test:unit`) — the script in the package's `package.json`.
 */
export function jsRunnerOf(command: string, workspace: string): JsRunnerOf | undefined {
  const named = RUNNER_WORD.exec(command)?.[1] as JsRunner | undefined;
  if (named) return { runner: named, dashDash: false };
  const m = /(?:^|&&\s*)(npm|yarn|pnpm|bun)\s+(?:run\s+)?([\w:.-]+)\s*$/.exec(command.trim());
  if (!m) return undefined;
  const [, pm, script] = m as unknown as [string, string, string];
  const dir = /^\s*cd\s+([^\s&;]+)\s*&&/.exec(command)?.[1] ?? ".";
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const body = pkg.scripts?.[script === "t" ? "test" : script] ?? "";
    const runner = RUNNER_WORD.exec(body)?.[1] as JsRunner | undefined;
    return runner ? { runner, dashDash: pm === "npm" } : undefined;
  } catch {
    return undefined;
  }
}

/** The runner's own arguments that write its JSON report to `file`, besides its usual output. */
export function reporterArgs(runner: JsRunner, file: string): string {
  if (runner === "jest") return `--json --outputFile=${file}`;
  if (runner === "vitest") return `--reporter=default --reporter=json --outputFile=${file}`;
  return `--reporter=json --reporter-option=output=${file}`;
}

/** An option the runner does not know: the report is dropped, the command runs as it was. */
export const UNKNOWN_OPTION =
  /unknown (option|argument)|unrecognized (option|argument)|unexpected argument|invalid option/i;

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colours in runner output
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

/** JavaScript frames in the project: `at fn (src/a.ts:12:5)`, `❯ src/a.test.ts:12:5`. */
export function jsFrames(text: string, workspace: string): StackFrame[] {
  const out: StackFrame[] = [];
  const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
  for (const raw of stripAnsi(text).split("\n")) {
    const m =
      /^\s*at\s+(?:(.+?)\s+\()?(?:file:\/\/)?([^()\s]+?):(\d+)(?::\d+)?\)?\s*$/.exec(raw) ??
      /^\s*❯\s+(?:(\S+)\s+)?(?:file:\/\/)?([^\s()]+?):(\d+)(?::\d+)?\s*$/.exec(raw);
    if (!m) continue;
    let file = m[2] as string;
    if (/node_modules|^node:|^internal\//.test(file)) continue;
    if (file.startsWith(root)) file = file.slice(root.length);
    out.push({ file, line: Number(m[3]), ...(m[1] ? { fn: m[1] } : {}), raw: raw.trim() });
  }
  return out;
}

/** Expected and actual in the JavaScript wordings: jest's and chai's (vitest). */
export function jsExpectedActual(message: string): { expected?: string; actual?: string } {
  const text = stripAnsi(message);
  const chai = /expected (.+?) to (?:be|equal|strictly equal|deeply equal|eql) (.+?)(?:\s+\/\/.*)?$/m.exec(
    text,
  );
  if (chai) return { expected: (chai[2] as string).trim(), actual: (chai[1] as string).trim() };
  const diff = /- Expected[^\n]*\n\+ Received[^\n]*\n\s*\n\s*- ([^\n]+)\n\s*\+ ([^\n]+)/.exec(text);
  if (diff) return { expected: (diff[1] as string).trim(), actual: (diff[2] as string).trim() };
  return expectedActualOf(text);
}

const relativeTo = (file: string, workspace: string): string => {
  const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
};

/** A jest (or vitest: the same shape) JSON report. */
export function parseJestJson(json: unknown, workspace: string): TestReport {
  const doc = (json ?? {}) as {
    numTotalTests?: number;
    testResults?: Array<{
      name?: string;
      status?: string;
      message?: string;
      assertionResults?: Array<{
        status?: string;
        title?: string;
        ancestorTitles?: string[];
        failureMessages?: string[];
      }>;
    }>;
  };
  const failures: TestFailure[] = [];
  for (const file of doc.testResults ?? []) {
    const path = file.name ? relativeTo(file.name, workspace) : undefined;
    const failed = (file.assertionResults ?? []).filter((a) => a.status === "failed");
    for (const a of failed) {
      const text = stripAnsi((a.failureMessages ?? []).join("\n"));
      failures.push({
        ...(a.ancestorTitles && a.ancestorTitles.length > 0 ? { suite: a.ancestorTitles.join(" › ") } : {}),
        name: a.title ?? "(unnamed)",
        ...(path ? { file: path } : {}),
        message: messageOf(text),
        ...jsExpectedActual(text),
        stack: jsFrames(text, workspace),
      });
    }
    // a file that did not run at all (a syntax error, a failed import): its message is the failure
    if (failed.length === 0 && file.status === "failed" && file.message) {
      const text = stripAnsi(file.message);
      failures.push({
        name: "the test file failed to run",
        ...(path ? { file: path } : {}),
        message: messageOf(text),
        stack: jsFrames(text, workspace),
      });
    }
  }
  return {
    source: "json",
    failures,
    ...(doc.numTotalTests !== undefined ? { total: doc.numTotalTests } : {}),
  };
}

/** A mocha JSON report. */
export function parseMochaJson(json: unknown, workspace: string): TestReport {
  const doc = (json ?? {}) as {
    stats?: { tests?: number };
    failures?: Array<{
      title?: string;
      fullTitle?: string;
      file?: string;
      err?: { message?: string; stack?: string; expected?: unknown; actual?: unknown };
    }>;
  };
  const failures: TestFailure[] = (doc.failures ?? []).map((f) => {
    const text = stripAnsi(`${f.err?.message ?? ""}\n${f.err?.stack ?? ""}`);
    const suite = f.fullTitle && f.title ? f.fullTitle.slice(0, -f.title.length).trim() : undefined;
    const expected = f.err?.expected !== undefined ? JSON.stringify(f.err.expected) : undefined;
    const actual = f.err?.actual !== undefined ? JSON.stringify(f.err.actual) : undefined;
    return {
      ...(suite ? { suite } : {}),
      name: f.title ?? "(unnamed)",
      ...(f.file ? { file: relativeTo(f.file, workspace) } : {}),
      message: messageOf(f.err?.message ?? text),
      ...(expected !== undefined && actual !== undefined ? { expected, actual } : jsExpectedActual(text)),
      stack: jsFrames(f.err?.stack ?? "", workspace),
    };
  });
  return { source: "json", failures, ...(doc.stats?.tests !== undefined ? { total: doc.stats.tests } : {}) };
}

/**
 * The failures in a jest or vitest run's printed output, when no JSON report came (a wrapper script,
 * a runner too old for the reporter): jest's `● Suite › test` blocks, vitest's `FAIL file > suite > test`.
 */
export function parseJsText(output: string, workspace: string): TestReport | undefined {
  const lines = stripAnsi(output).split("\n");
  const failures: TestFailure[] = [];
  let current: { head: string; file?: string; body: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    const text = current.body.join("\n");
    const parts = current.head.split(/\s+[›>]\s+/);
    const name = parts.at(-1) ?? current.head;
    const suite = parts.slice(0, -1).join(" › ");
    failures.push({
      ...(suite ? { suite } : {}),
      name,
      ...(current.file ? { file: current.file } : {}),
      message: messageOf(text),
      ...jsExpectedActual(text),
      stack: jsFrames(text, workspace),
    });
    current = undefined;
  };
  for (const line of lines) {
    const jest = /^\s{0,4}● (.+)$/.exec(line);
    const vitest = /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?)\s+>\s+(.+)$/.exec(line);
    if (jest && !/^Console$/.test(jest[1] as string)) {
      flush();
      current = { head: (jest[1] as string).trim(), body: [] };
    } else if (vitest) {
      flush();
      current = { head: (vitest[2] as string).trim(), file: vitest[1] as string, body: [] };
    } else if (/^\s*(Test Suites:|Tests:|Test Files\s|⎯{3,}|Snapshots:)/.test(line)) {
      flush();
    } else if (current) current.body.push(line);
  }
  flush();
  return failures.length > 0 ? { source: "text", failures } : undefined;
}

/** Why a failed run failed: the runner's JSON report, else its printed output. */
export function jsReportOf(
  runner: JsRunner,
  file: string | undefined,
  output: string,
  workspace: string,
): TestReport | undefined {
  if (file && existsSync(file)) {
    try {
      const json: unknown = JSON.parse(readFileSync(file, "utf8"));
      const report = runner === "mocha" ? parseMochaJson(json, workspace) : parseJestJson(json, workspace);
      if (report.failures.length > 0) return report;
    } catch {
      // a report cut short: the printed output below
    }
  }
  // mocha's JSON on stdout when it would not write the file
  if (runner === "mocha") {
    const start = output.indexOf("{\n");
    if (start >= 0)
      try {
        const body = output.slice(start).replace(/\n\[(?:stderr|exit)[\s\S]*$/, "");
        return parseMochaJson(JSON.parse(body), workspace);
      } catch {
        // not JSON
      }
  }
  return parseJsText(output, workspace);
}

/** The adapter's test reporter. */
export const JS_TEST_REPORTER: TestReporter = {
  runnerOf: (command, workspace) => jsRunnerOf(command, workspace),
  reporterArgs: (runner, file) => reporterArgs(runner as JsRunner, file),
  unknownOption: UNKNOWN_OPTION,
  // jest finds the tests of changed files itself; vitest takes test files as filters; none related
  // is not a failure (pilot: jest exited 1 on «0 matches»)
  selection: (runner) =>
    runner === "jest"
      ? { by: "changed", args: (files) => `--passWithNoTests --findRelatedTests ${files}` }
      : runner === "vitest"
        ? { by: "tests", args: (files) => `--passWithNoTests ${files}` }
        : undefined,
  failures: (runner, file, output, workspace) => jsReportOf(runner as JsRunner, file, output, workspace),
};
