import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { shortRunId } from "../../src/storage/runStore.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
const ENV = { PATH: process.env.PATH ?? "" };

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: sb.project,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write(
    "project/.jarvis/project.yaml",
    "version: 1\nstack: [typescript, react]\nworkspace: { mode: cwd }\n",
  );
  sb.write(
    "project/.jarvis/standards/no-console.md",
    "---\nid: no-console\ntitle: No console output\nscope: { paths: ['src/**'] }\nverification:\n  kind: deterministic\n  check: { pattern: { glob: 'src/**/*.ts', mustNot: 'console\\.log' } }\n---\nUse the logger.\n",
  );
  sb.write(
    "project/.jarvis/standards/naming.md",
    "---\nid: naming\ntitle: Naming\nseverity: recommended\n---\nCamel case.\n",
  );
  sb.write(
    "project/.jarvis/skills/react-component-change/skill.yaml",
    "id: react-component-change\nappliesTo: { stacks: [react] }\n",
  );
  sb.write("project/.jarvis/skills/react-component-change/instructions.md", "Hooks first.");
  mkdirSync(join(sb.project, "src"), { recursive: true });
  writeFileSync(join(sb.project, "src", "a.ts"), "export const a = 1;\n");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  sb.cleanup();
});

async function jarvis(args: string[]) {
  let out = "";
  let err = "";
  const code = await run(["node", "jarvis", ...args], {
    streams: {
      out: new Writable({
        write(c, _e, cb) {
          out += String(c);
          cb();
        },
      }),
      err: new Writable({
        write(c, _e, cb) {
          err += String(c);
          cb();
        },
      }),
    },
    context: { cwd: sb.project, homeDir: sb.home, env: ENV },
  });
  return { code, out, err };
}

describe("jarvis standards / skills", () => {
  it("lists standards and checks the working tree against them", async () => {
    const list = await jarvis(["standards", "list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("no-console  1  required     deterministic  paths src/**");
    expect(list.out).toContain("naming      1  recommended  semantic       any");

    const clean = await jarvis(["standards", "check"]);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("no violations");

    writeFileSync(join(sb.project, "src", "a.ts"), "export const a = 1;\nconsole.log(a);\n");
    const dirty = await jarvis(["--json", "standards", "check"]);
    expect(dirty.code).toBe(1);
    const report = JSON.parse(dirty.out) as { violations: Array<{ standardId: string; line: number }> };
    expect(report.violations).toEqual([
      expect.objectContaining({ standardId: "no-console", file: "src/a.ts", line: 2 }),
    ]);
  });

  it("lists skills with the selection for the detected stack", async () => {
    const list = await jarvis(["skills", "list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("stacks: typescript, react; agent: implementation");
    expect(list.out).toMatch(
      /\* react-component-change\s+v1\s+project\s+stacks react; agents implementation/,
    );
    expect(list.out).toMatch(/\* sdd-implementation\s+v1\s+builtin/);
    expect(list.out).toMatch(/ {2}unit-testing\s+v1\s+builtin/);
  });
});

describe("jarvis candidates", () => {
  it("lists, promotes to a standard file and rejects", async () => {
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: ENV });
    const rt = createRuntime(loaded, { env: ENV });
    const runRec = rt.runs.create({
      task: "ABC-9",
      workflow: "sdd",
      owner: { kind: "user", id: "me@corp", verified: false },
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    const put = (i: number, kind: string, title: string) =>
      rt.artifacts.put({
        runId: runRec.id,
        type: "candidate",
        name: `review-1-${i}.json`,
        content: JSON.stringify({
          kind,
          title,
          rationale: "seen 3 times",
          evidence: ["src/a.ts:1"],
          proposal: "Never do X.",
          status: "proposed",
        }),
        mediaType: "application/json",
        provenance: { kind: "agent", agentId: "review" },
        stepId: "review",
        iteration: 1,
      });
    const c1 = put(1, "standard", "Repository access only via services");
    const c2 = put(2, "knowledge", "Orders are immutable after dispatch");
    await rt.close();

    const list = await jarvis(["--json", "candidates", "list"]);
    expect(list.code).toBe(0);
    const rows = (
      JSON.parse(list.out) as { candidates: Array<{ id: string; kind: string; decision: string }> }
    ).candidates;
    expect(rows.map((r) => [r.id, r.kind, r.decision])).toEqual([
      [c1.artifactId, "standard", "open"],
      [c2.artifactId, "knowledge", "open"],
    ]);

    const promoted = await jarvis(["candidates", "promote", c1.artifactId.slice(0, 10)]);
    expect(promoted.code).toBe(0);
    const file = join(sb.project, ".jarvis", "standards", "repository-access-only-via-services.md");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("id: repository-access-only-via-services");
    expect(text).toContain("severity: recommended");
    expect(text).toContain(`ref: ${c1.artifactId}@1`);
    expect(text.trim().endsWith("Never do X.")).toBe(true);
    // the new file is a valid standard
    const standards = await jarvis(["standards", "list"]);
    expect(standards.out).toContain("repository-access-only-via-services");

    const rejected = await jarvis(["candidates", "reject", c2.artifactId, "--comment", "not general"]);
    expect(rejected.code).toBe(0);
    const open = JSON.parse((await jarvis(["--json", "candidates", "list"])).out) as {
      candidates: unknown[];
    };
    expect(open.candidates).toEqual([]);
    const all = JSON.parse((await jarvis(["--json", "candidates", "list", "--all"])).out) as {
      candidates: Array<{ decision: string }>;
    };
    expect(all.candidates.map((c) => c.decision)).toEqual(["approve", "reject"]);

    const again = await jarvis(["candidates", "promote", c1.artifactId]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already exists");
  });
});

describe("jarvis candidates: names", () => {
  it("names module maps by module, tells duplicates apart by run and accepts any unique part", async () => {
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: ENV });
    const rt = createRuntime(loaded, { env: ENV });
    const newRun = () =>
      rt.runs.create({
        task: "onboard",
        workflow: "onboard-module",
        owner: { kind: "user", id: "me@corp", verified: false },
        workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
        dataClass: "internal",
      });
    const put = (runId: string, module: string, review: string[]) =>
      rt.artifacts.put({
        runId,
        type: "candidate",
        name: "module.json",
        content: JSON.stringify({
          kind: "knowledge",
          title: `module ${module}`,
          module,
          claims: { proposed: 5, kept: 4, dropped: 1 },
          review,
          rationale:
            "Mapped by the onboarding agent; 4 of 5 claims were confirmed against the code, 1 dropped.",
          evidence: [`${module}/a.ts:1`, `${module}/a.ts:9`, `${module}/b.ts:3`],
          proposal: `---\nkind: module\n---\n# ${module}\n\n## Responsibilities\n- Does things.\n`,
          status: "proposed",
        }),
        mediaType: "application/json",
        provenance: { kind: "agent", agentId: "onboard-mapper" },
        stepId: "map",
        iteration: 1,
      });
    const older = newRun();
    put(older.id, "packages/shared-lib/src/billing", []);
    const plugins = newRun();
    put(plugins.id, "server/plugins", ["Every request is logged by this plugin."]);
    const newer = newRun();
    put(newer.id, "packages/shared-lib/src/billing", []);
    await rt.close();

    const list = await jarvis(["candidates", "list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("3 candidates");
    expect(list.out).toContain("● shared-lib/billing\n");
    expect(list.out).toContain(`● shared-lib/billing@${shortRunId(older.id)}\n`);
    expect(list.out).toContain("● server/plugins\n");
    expect(list.out).toContain("claims 4/5 confirmed, 1 dropped · 1 to check");
    expect(list.out).toContain("evidence  plugins/a.ts, plugins/b.ts");
    expect(list.out).toContain("? Every request is logged by this plugin.");
    expect(list.out).toContain("jarvis candidates show <name>");

    const show = await jarvis(["candidates", "show", "plugins"]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("server/plugins — knowledge, open");
    expect(show.out).toContain(join(".jarvis", "knowledge", "module-server-plugins.md"));
    expect(show.out).toContain("  ? Every request is logged by this plugin.");
    expect(show.out).toContain("## Responsibilities");

    const ambiguous = await jarvis(["candidates", "show", "billing"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain('"billing" matches 2 candidates');

    const promoted = await jarvis(["candidates", "promote", "shared-lib/billing"]);
    expect(promoted.code).toBe(0);
    const file = join(sb.project, ".jarvis", "knowledge", "module-shared-lib-billing.md");
    expect(readFileSync(file, "utf8")).toMatch(/^---\nsource: art_/);
    // the promoted one is decided: the other billing map is the only open match now
    const rest = await jarvis(["candidates", "reject", "billing"]);
    expect(rest.code).toBe(0);
    expect(rest.out).toContain(`rejected shared-lib/billing@${shortRunId(older.id)}`);
  });
});
