import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { Runtime } from "../app/runtime.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import { git, runShell } from "../tools/local/exec.ts";

/**
 * ADR-0012 §3: a finished run becomes an eval case — the task, the repository at the base commit as
 * fixture, gold from what the human accepted (changed files, acceptance criteria, the sources the
 * human-edited artifacts cite). Secrets were redacted at write time (ADR-0010); the case still gets
 * a human look before it joins a suite, because it carries project context.
 */
export interface RunToCaseOptions {
  readonly suiteDir: string;
  readonly id?: string;
  /** Include the fixture (git archive of the base commit); off writes case.yaml only. */
  readonly fixture?: boolean;
}

export interface RunToCaseResult {
  readonly caseDir: string;
  readonly files: string[];
  readonly acceptance: string[];
  readonly requiredSources: string[];
  readonly humanVersions: string[];
  readonly fixture: boolean;
}

/** The newest human-edited version of an artifact type, else the latest agent version. */
function preferred(runtime: Runtime, runId: string, type: string): ArtifactVersion | undefined {
  const latest = runtime.artifacts.listLatest(runId, type)[0];
  if (!latest) return undefined;
  const versions = runtime.artifacts.versions(latest.artifactId);
  return [...versions].reverse().find((v) => v.provenance.kind === "human") ?? latest;
}

export async function runToCase(
  runtime: Runtime,
  runId: string,
  options: RunToCaseOptions,
): Promise<RunToCaseResult> {
  const run = runtime.runs.require(runId);
  const id =
    options.id ??
    run.task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const caseDir = join(options.suiteDir, id);
  if (existsSync(join(caseDir, "case.yaml"))) throw new Error(`case ${caseDir} already exists`);
  mkdirSync(caseDir, { recursive: true });

  const ws = run.workspace;
  const base = ws.baseCommit ?? ws.baseRef;
  const diffFrom = existsSync(ws.path) ? ws.path : ws.repoRoot;
  const diff = await git(["diff", "--name-only", `${base}..HEAD`], diffFrom);
  const working = await git(["diff", "--name-only", "HEAD"], diffFrom);
  const files = [
    ...new Set(`${diff.stdout}\n${working.stdout}`.split("\n").filter((f) => f && !f.startsWith(".jarvis/"))),
  ].sort();

  const spec = preferred(runtime, run.id, "spec");
  const impact = preferred(runtime, run.id, "impact");
  const research = preferred(runtime, run.id, "research");
  const humanVersions = [spec, impact, research]
    .filter((a): a is ArtifactVersion => a?.provenance.kind === "human")
    .map((a) => `${a.type}@${a.version}`);
  let acceptance: string[] = [];
  if (spec) {
    try {
      const doc = JSON.parse(runtime.artifacts.text(spec)) as {
        requirements?: Array<{ acceptance?: string[] }>;
      };
      acceptance = [...new Set((doc.requirements ?? []).flatMap((r) => r.acceptance ?? []))];
    } catch {
      // not JSON
    }
  }
  // Required evidence: the sources human-edited artifacts cite (ADR-0015 §6); agent-only ones are not gold.
  const requiredSources = [
    ...new Set(
      [spec, impact, research]
        .filter((a): a is ArtifactVersion => a?.provenance.kind === "human")
        .flatMap((a) => a.sourceRefs),
    ),
  ]
    .filter((s) => !/^(standard|skill|knowledge):/.test(s))
    .sort();

  const tests =
    runtime.loaded.config.tools.local.test ??
    runtime.loaded.config.tools.local.tests ??
    runtime.loaded.config.tools.local.check;
  const caseDoc = {
    id,
    task: run.task,
    workflow: run.workflow,
    fixture: "fixture",
    gold: {
      files,
      ...(tests ? { tests } : {}),
      acceptance,
      requiredSources,
    },
    cassette: "cassette",
    source: { run: run.id, baseCommit: base, exportedAt: new Date().toISOString(), humanVersions },
  };
  writeFileSync(join(caseDir, "case.yaml"), stringify(caseDoc));
  mkdirSync(join(caseDir, "cassette"), { recursive: true });
  writeFileSync(
    join(caseDir, "cassette", "README.md"),
    "Recorded by `jarvis evals run --mode record`; empty until then.\n",
  );

  let fixture = false;
  if (options.fixture !== false) {
    const fixtureDir = join(caseDir, "fixture");
    mkdirSync(fixtureDir, { recursive: true });
    const archive = await runShell(`git archive --format=tar ${base} | tar -x -C "${fixtureDir}"`, {
      cwd: ws.repoRoot,
      timeoutMs: 300_000,
    });
    if (archive.code !== 0) throw new Error(`git archive ${base} failed: ${archive.stderr.trim()}`);
    fixture = true;
  }
  return { caseDir, files, acceptance, requiredSources, humanVersions, fixture };
}
