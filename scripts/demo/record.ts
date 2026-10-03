/**
 * Records terminal sessions for the README GIFs against the scripted model used in tests.
 * Output: scripts/demo/out/<scenario>.json — [{ command, output }] per scenario.
 *   node scripts/demo/record.ts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { run } from "../../src/cli/main.ts";
import { type CapturedRequest, completion, startFakeOpenAi, toolCallCompletion } from "../../tests/helpers/fakeOpenAi.ts";

const gitEnv = { GIT_AUTHOR_NAME: "maxim", GIT_AUTHOR_EMAIL: "maxim@corp", GIT_COMMITTER_NAME: "maxim", GIT_COMMITTER_EMAIL: "maxim@corp" };
const base = { summary: "s", sources: ["src/onboarding.ts"], reasons: [] };
const docs: Record<string, unknown> = {
  research: { ...base, summary: "Onboarding restart is blocked by a hard-coded flag in src/onboarding.ts.", findings: [{ topic: "restart flag", detail: "canRestartOnboarding() always returns false", sources: ["src/onboarding.ts:2"] }], affectedAreas: ["src"], outcome: "ok" },
  requirements: { ...base, requirements: [{ id: "R1", text: "A rejected applicant may restart onboarding once", verifiable: true, sources: ["ABC-42"] }], businessRules: ["Only REJECTED applications may restart"], verdict: "READY", outcome: "ok" },
  specification: { ...base, title: "Allow onboarding restart after rejection", goals: ["restart allowed once after a rejection"], requirements: [{ id: "R1", text: "canRestartOnboarding returns true for REJECTED applications", acceptance: ["unit test covers REJECTED and PROCESSING"] }], outcome: "ok" },
  impact: { ...base, affected: [{ path: "src/onboarding.ts", kind: "code", reason: "flag logic" }, { path: "src/onboarding.test.ts", kind: "test", reason: "new cases" }], outcome: "ok" },
  plan: { ...base, steps: [{ id: "S1", description: "replace the constant with a status check", files: ["src/onboarding.ts"], verification: "project.tests" }], outcome: "ok" },
  implementation: { ...base, changedFiles: ["src/onboarding.ts"], notes: ["kept the function signature"], outcome: "ok" },
  test: { ...base, commandsRun: ["project.tests"], passed: true, outcome: "ok" },
  review: { ...base, findings: [], verdict: "approve", outcome: "ok" },
  docs: { ...base, updatedFiles: ["README.md"], outcome: "ok" },
  telemetry: { ...base, events: [{ name: "onboarding_restarted", when: "restart accepted", properties: ["applicationId"], status: "proposed" }], outcome: "ok" },
  "release-notes": { ...base, title: "Onboarding restart", highlights: ["Rejected applicants can restart onboarding once"], markdown: "# Onboarding restart\n- Rejected applicants can restart onboarding once", outcome: "ok" },
};

interface Scenario {
  readonly name: string;
  readonly steps: (ctx: { jarvis: (args: string[], stdin?: string) => Promise<string>; project: string; wt: () => string }) => Promise<Array<{ command: string; output: string }>>;
  readonly overrides?: (req: CapturedRequest, agent: string, state: Record<string, number>) => ReturnType<typeof completion> | undefined;
}

async function record(scenario: Scenario): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "jarvis-demo-"));
  const home = join(root, "home");
  const project = join(root, "payments-service");
  mkdirSync(join(home, ".jarvis"), { recursive: true });
  mkdirSync(join(project, ".jarvis", "knowledge"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  const server = await startFakeOpenAi();
  writeFileSync(
    join(home, ".jarvis", "config.yaml"),
    `version: 1\nactor: { id: maxim@corp }\nmodels:\n  deepseek-flash: { provider: openai-compatible, baseUrl: ${server.baseUrl}, model: deepseek-flash, egress: private, contextWindow: 128000, maxOutput: 8192, supports: { tools: true, jsonMode: true } }\nroles:\n  research: { models: [deepseek-flash] }\n  implementation: { models: [deepseek-flash] }\n  review: { models: [deepseek-flash] }\n`,
  );
  writeFileSync(join(project, ".jarvis", "project.yaml"), "version: 1\ndataClass: internal\nstack: [typescript]\ntools:\n  local: { tests: 'test -f src/onboarding.ts' }\n");
  writeFileSync(join(project, ".jarvis", "knowledge", "domain.md"), "# Onboarding\n\nApplications move NEW → PROCESSING → ACCEPTED | REJECTED.\n");
  writeFileSync(join(project, "src", "onboarding.ts"), "export function canRestartOnboarding() {\n  return false;\n}\n");
  writeFileSync(join(project, "tsconfig.json"), "{}");
  const git = (args: string[], cwd = project) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);

  const state: Record<string, number> = {};
  server.respond((req) => {
    const system = (req.body.messages as Array<{ content: string }>)[0]?.content ?? "";
    const agent = system.startsWith("# Jarvis clarification thread") ? "clarifier" : (/# Agent: ([\w-]+)/.exec(system)?.[1] ?? "?");
    const custom = scenario.overrides?.(req, agent, state);
    if (custom) return custom;
    const tools = (req.body.messages as Array<{ role: string }>).filter((m) => m.role === "tool").length;
    if (!req.body.tools) return completion(JSON.stringify(docs[agent]));
    if (agent === "implementation" && tools === 0) {
      state.impl = (state.impl ?? 0) + 1;
      return toolCallCompletion("repo.edit", { path: "src/onboarding.ts", oldText: state.impl === 1 ? "return false;" : "return status === \"REJECTED\";", newText: state.impl === 1 ? "return status === \"REJECTED\";" : "return status === RESTARTABLE;" });
    }
    if (agent === "research" && tools === 0) return toolCallCompletion("repo.search", { pattern: "canRestartOnboarding" });
    if (agent === "test" && tools === 0) return toolCallCompletion("project.tests", {});
    return completion("done");
  });

  let lastRun = "";
  const jarvis = async (args: string[], stdin?: string) => {
    let out = "";
    const streams = {
      out: new Writable({ write(c, _e, cb) { out += String(c); cb(); } }),
      err: new Writable({ write(c, _e, cb) { out += String(c); cb(); } }),
    };
    const { Readable } = await import("node:stream");
    await run(["node", "jarvis", ...args], { streams, ...(stdin !== undefined ? { stdin: Readable.from([stdin]) } : {}), context: { cwd: project, homeDir: home, env: { PATH: process.env.PATH ?? "", ...gitEnv } } });
    const m = /run (run_[0-9a-f]+)/.exec(out);
    if (m) lastRun = m[1] as string;
    return out.replace(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "~").replace(/~\/home\/\.jarvis/g, "~/.jarvis");
  };
  const wt = () => {
    const db = readFileSync(join(home, ".jarvis", "jarvis.db")) ? "" : "";
    void db;
    const out = execFileSync("ls", [join(home, ".jarvis", "worktrees")], { encoding: "utf8" }).trim().split("\n")[0] as string;
    const inner = execFileSync("ls", [join(home, ".jarvis", "worktrees", out)], { encoding: "utf8" }).trim().split("\n")[0] as string;
    return join(home, ".jarvis", "worktrees", out, inner);
  };
  try {
    const frames = await scenario.steps({ jarvis, project, wt });
    mkdirSync(join(import.meta.dirname, "out"), { recursive: true });
    writeFileSync(join(import.meta.dirname, "out", `${scenario.name}.json`), JSON.stringify(frames.map((f) => ({ ...f, output: f.output.replace(/run_[0-9a-f]{20}/g, (id) => id) })), null, 2));
    console.log(`${scenario.name}: ${frames.length} frame(s)${lastRun ? ` (last run ${lastRun})` : ""}`);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const short = (out: string) => /\((\w{8})\)/.exec(out)?.[1] ?? "";

const scenarios: Scenario[] = [
  {
    name: "work",
    steps: async ({ jarvis }) => {
      const frames: Array<{ command: string; output: string }> = [];
      const work = await jarvis(["work", "ABC-42"]);
      frames.push({ command: "jarvis work ABC-42", output: work });
      const id = short(work);
      frames.push({ command: `jarvis status ${id}`, output: await jarvis(["status", id]) });
      frames.push({ command: `jarvis approve ${id} --resume`, output: await jarvis(["approve", id, "--resume"]) });
      frames.push({ command: `jarvis approve ${id} --resume`, output: await jarvis(["approve", id, "--resume"]) });
      frames.push({ command: `jarvis diff ${id}`, output: await jarvis(["diff", id]) });
      frames.push({ command: `jarvis apply ${id}`, output: await jarvis(["apply", id]) });
      return frames;
    },
  },
  {
    name: "clarify",
    overrides: (req, agent, state) => {
      if (agent === "requirements" && !req.body.tools) {
        state.req = (state.req ?? 0) + 1;
        if (state.req === 1)
          return completion(JSON.stringify({ ...base, requirements: [], verdict: "NEEDS_CLARIFICATION", clarification: { question: "What happens when a rejected applicant re-submits while the first retry is still PROCESSING?", context: "Two readings: the retry is idempotent, or the duplicate is rejected." }, outcome: "needs_clarification" }));
      }
      if (agent === "clarifier" && !req.body.tools) {
        const thread = (req.body.messages as Array<{ role: string; content: string }>).map((m) => m.content).join("\n");
        return /Human: return the existing/i.test(thread)
          ? completion(JSON.stringify({ kind: "resolution", text: "Retry is idempotent while a previous attempt is PROCESSING or completed.", proposal: { rule: "A retry returns the existing application for PROCESSING and completed attempts; only REJECTED starts a new one.", requirementCorrections: ["R2: retry is idempotent for PROCESSING/completed attempts"], assumptions: [] } }))
          : completion(JSON.stringify({ kind: "question", text: "Should this also apply while the first attempt is still PROCESSING?" }));
      }
      return undefined;
    },
    steps: async ({ jarvis }) => {
      const frames: Array<{ command: string; output: string }> = [];
      const work = await jarvis(["work", "ABC-42"]);
      frames.push({ command: "jarvis work ABC-42", output: work });
      const id = short(work);
      frames.push({ command: "jarvis threads", output: await jarvis(["threads"]) });
      frames.push({ command: `jarvis attach ${id} --no-resume`, output: await jarvis(["attach", id, "--no-resume"], "reject the duplicate\nreturn the existing application\na\n") });
      frames.push({ command: `jarvis status ${id}`, output: await jarvis(["status", id]) });
      return frames;
    },
  },
  {
    name: "review",
    overrides: (req, agent) => {
      if (agent === "review-analysis" && !req.body.tools)
        return completion(JSON.stringify({ ...base, comments: [{ id: "R-1", class: "CODE", action: "use the RESTARTABLE constant instead of the literal", file: "src/onboarding.ts", line: 2 }, { id: "R-2", class: "KNOWLEDGE_CANDIDATE", action: "record: statuses are compared through named constants" }], verdict: "fix_code", candidates: [{ kind: "knowledge", title: "Statuses are compared through named constants", rationale: "R-2", evidence: ["src/onboarding.ts:2"] }], reasons: [{ kind: "finding", summary: "R-1 src/onboarding.ts:2 use the RESTARTABLE constant", sourceRefs: ["src/onboarding.ts:2"] }], outcome: "fix_required" }));
      return undefined;
    },
    steps: async ({ jarvis, wt }) => {
      const frames: Array<{ command: string; output: string }> = [];
      const work = await jarvis(["work", "ABC-42"]);
      const id = short(work);
      await jarvis(["approve", id, "--resume"]);
      frames.push({ command: `jarvis status ${id}`, output: await jarvis(["status", id]) });
      const file = join(wt(), "src", "onboarding.ts");
      const src = readFileSync(file, "utf8").replace('  return status === "REJECTED";', '  // REVIEW: use the RESTARTABLE constant instead of the literal\n  return status === "REJECTED"; // REVIEW: record this convention');
      writeFileSync(file, src);
      frames.push({ command: `$EDITOR src/onboarding.ts   # add // REVIEW: comments`, output: src });
      frames.push({ command: `jarvis review submit ${id} --resume`, output: await jarvis(["review", "submit", id, "--resume"]) });
      frames.push({ command: `jarvis review status ${id}`, output: await jarvis(["review", "status", id]) });
      frames.push({ command: `jarvis candidates list`, output: await jarvis(["candidates", "list"]) });
      return frames;
    },
  },
];

for (const s of scenarios) await record(s);
