import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectGraphExtractor } from "../../core/capabilities/contracts.ts";
import type { GraphStore } from "../../knowledge/graph/store.ts";
import { impactOf, repoIdOf } from "../../knowledge/graph/update.ts";
import { quoteArg } from "../../tools/local/args.ts";

/**
 * How a `test*` command takes the tests to run, by its runner: jest finds the tests related to the
 * changed files itself; a Gradle or Maven test task takes test classes — the ones the project graph
 * says cover the change. A Spring service of ~120 test classes on Testcontainers would otherwise run
 * the whole suite on every round of verify, for a change two test classes cover.
 */
export type TestRunner = "jest" | "gradle" | "maven";

export function testRunnerOf(command: string): TestRunner | undefined {
  if (/\bjest\b/.test(command)) return "jest";
  // the test task last: `--tests` belongs to the task before it
  if (/(^|[\s/])gradlew?\s/.test(command) && /(\s|:)test\s*$/.test(command)) return "gradle";
  if (/(^|[\s/])mvnw?\s/.test(command) && /\s(test|verify)(\s|$)/.test(command)) return "maven";
  return undefined;
}

/** A test file as its class: `src/test/groovy/a/b/OrderSpec.groovy` → `a.b.OrderSpec`. */
export function testClassOf(file: string): string | undefined {
  const m = /(?:^|\/)src\/[^/]+\/(?:java|groovy|kotlin|scala)\/(.+)\.(?:java|groovy|kt|scala)$/.exec(file);
  return m ? (m[1] as string).split("/").join(".") : undefined;
}

/** Arguments of the runner for these test classes. */
export function testClassArgs(runner: "gradle" | "maven", classes: readonly string[]): string {
  if (runner === "gradle") return classes.map((c) => `--tests ${quoteArg(c)}`).join(" ");
  // a module of the build without one of them is no failure
  return `${quoteArg(`-Dtest=${classes.join(",")}`)} -Dsurefire.failIfNoSpecifiedTests=false`;
}

/** Above this many classes the whole suite runs: a filter that long is no selection. */
const MAX_CLASSES = 150;

/**
 * The test files that cover the changed code: from the project graph of the base (built by
 * `discover`; the run's own changes are not in the index yet), plus the changed files that are tests
 * themselves — read now, with the extractor, not from the graph. Undefined: no graph to tell, run
 * them all.
 */
export function coveringTests(options: {
  readonly workspace: string;
  readonly store: GraphStore;
  readonly extractors: readonly ProjectGraphExtractor[];
  readonly changed: readonly string[];
}): Promise<string[] | undefined> {
  return (async () => {
    const latest = options.store.latest(repoIdOf(options.workspace));
    const snapshot = latest ? options.store.load(latest.id) : undefined;
    if (!snapshot) return undefined;
    const tests = new Set(impactOf(snapshot, options.changed).tests);
    for (const file of options.changed) {
      const x = options.extractors.find((e) => e.extensions.some((ext) => file.endsWith(ext)));
      if (!x) continue;
      try {
        const facts = await x.extract(file, readFileSync(join(options.workspace, file), "utf8"));
        if (facts.nodes.some((n) => n.id === file && n.kind === "Test")) tests.add(file);
      } catch {
        // deleted or unreadable: nothing to run
      }
    }
    return [...tests].sort();
  })();
}

/**
 * The selection for a `test*` command of a class-taking runner: its arguments, a reason to skip it,
 * or nothing (run it as it is).
 */
export function classSelection(
  runner: "gradle" | "maven",
  tests: readonly string[] | undefined,
): { args: string } | { skip: string } | undefined {
  if (tests === undefined) return undefined;
  const classes = [...new Set(tests.map(testClassOf).filter((c): c is string => c !== undefined))].sort();
  if (classes.length === 0) return { skip: "no test covers the changed code (project graph)" };
  if (classes.length > MAX_CLASSES) return undefined;
  return { args: testClassArgs(runner, classes) };
}

/** Test files given to a runner as filters, at most: past it the whole suite is about as fast. */
export const MAX_TEST_FILES = 60;

/**
 * The selection for a runner that takes test files as filters (vitest): the files, a reason to skip,
 * or nothing (run it as it is: no graph to tell, or too many files).
 */
export function fileSelection(
  tests: readonly string[] | undefined,
): { files: string[] } | { skip: string } | undefined {
  if (tests === undefined) return undefined;
  if (tests.length === 0) return { skip: "no test covers the changed code (project graph)" };
  if (tests.length > MAX_TEST_FILES) return undefined;
  return { files: [...tests] };
}
