import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { cdTo, guessStart, tryCommand, tryOutOf } from "../../src/app/tryOut.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import type { Run } from "../../src/core/domain/run.ts";
import { workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** How a person tries the result before the implementation gate: deterministic, from the run and the config. */
let sb: Sandbox | undefined;
let rt: Runtime | undefined;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };

async function setUp(project: string): Promise<{ run: Run; rt: Runtime; sb: Sandbox }> {
  const box = sandbox();
  sb = box;
  box.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  box.write("project/.jarvis/project.yaml", project);
  box.write("home/.jarvis/worktrees/web/1a2b3c4d-ABC-42/yarn.lock", "");
  box.write(
    "home/.jarvis/worktrees/web/1a2b3c4d-ABC-42/package.json",
    JSON.stringify({ scripts: { build: "x", start: "y", "start-dev": "z" } }),
  );
  const live = createRuntime(await loadConfig({ cwd: box.project, homeDir: box.home, env: {} }), { env: {} });
  rt = live;
  const run = live.runs.create({
    task: "ABC-42",
    workflow: "sdd",
    owner: DEV,
    workspace: {
      mode: "worktree",
      repoRoot: box.project,
      path: `${box.home}/.jarvis/worktrees/web/1a2b3c4d-ABC-42`,
      branch: "jarvis/ABC-42/1a2b3c4d",
      baseRef: "HEAD",
      baseCommit: "5407129b0000",
    },
    dataClass: "internal",
  });
  live.artifacts.put({
    runId: run.id,
    type: "spec",
    name: "spec.json",
    content: JSON.stringify({
      title: "Delivery slots",
      goals: ["g"],
      requirements: [
        { id: "R1", text: "Slots come from logistics-api", acceptance: ["a closed zone shows no slots"] },
        { id: "R2", text: "No acceptance here", acceptance: [] },
      ],
    }),
    provenance: { kind: "agent", agentId: "spec" },
  });
  live.artifacts.put({
    runId: run.id,
    type: "tests",
    name: "tests.json",
    content: JSON.stringify({ summary: "s", commandsRun: ["yarn jest slots"], passed: true, failures: [] }),
    provenance: { kind: "agent", agentId: "test" },
  });
  return { run, rt: live, sb: box };
}
afterEach(async () => {
  await rt?.close();
  sb?.cleanup();
  rt = undefined;
  sb = undefined;
});

const GATE = workflowOf({
  name: "sdd",
  entry: "implementation",
  steps: [
    {
      id: "implementation",
      kind: "agentic",
      agent: "implementation",
      transitions: { onSuccess: "approve-impl" },
    },
    {
      id: "approve-impl",
      kind: "approval",
      artifactType: "implementation",
      transitions: {
        onSuccess: "release-notes",
        onOutcome: { request_changes: { to: "implementation", maxIterations: 3 } },
      },
    },
    { id: "release-notes", kind: "agentic", agent: "release-notes", transitions: { onSuccess: "DONE" } },
  ],
});

describe("Try it", () => {
  it("takes the start command from workspace.try, the checks from the spec, the way on from the workflow", async () => {
    const { run, rt, sb } = await setUp(
      'version: 1\nworkspace:\n  mode: worktree\n  setup: "yarn install --immutable"\n  try: { run: "yarn workspace web start-dev", url: "http://localhost:3000" }\n',
    );
    const t = tryOutOf(rt, run, { workflow: GATE, homeDir: sb.home });
    expect(t).toMatchObject({
      checkoutShown: "~/.jarvis/worktrees/web/1a2b3c4d-ABC-42",
      branch: "jarvis/ABC-42/1a2b3c4d",
      range: "5407129b..jarvis/ABC-42/1a2b3c4d",
      setup: "yarn install --immutable",
      start: ["yarn workspace web start-dev"],
      guessed: false,
      url: "http://localhost:3000",
      checks: [
        { id: "R1", text: "Slots come from logistics-api", acceptance: ["a closed zone shows no slots"] },
      ],
      verified: { passed: true, commands: ["yarn jest slots"], failures: 0 },
    });
    expect(t?.inRepo?.commands).toEqual([
      `git switch -c try-${run.id.slice(4, 12)} jarvis/ABC-42/1a2b3c4d`,
      "yarn install --immutable",
      "yarn workspace web start-dev",
    ]);
    expect(t?.onAccept).toContain("release-notes, then the run completes");
    expect(t?.apply).toBe(`jarvis apply ${run.id.slice(4, 12)}`);
    expect(t?.onSendBack).toContain("implementation again");
    expect(tryCommand(t as NonNullable<typeof t>)).toBe(
      "cd ~/.jarvis/worktrees/web/1a2b3c4d-ABC-42 && yarn workspace web start-dev",
    );
  });

  it("guesses the start command from package.json when the project does not say it", async () => {
    const { run, rt, sb } = await setUp("version: 1\nworkspace: { mode: worktree }\n");
    const t = tryOutOf(rt, run, { homeDir: sb.home });
    expect(t).toMatchObject({ start: ["yarn start-dev"], guessed: true });
    expect(guessStart(sb.project)).toEqual([]);
  });

  it("is not offered for a run without its own checkout", async () => {
    const { run, rt } = await setUp("version: 1\nworkspace: { mode: cwd }\n");
    const cwd = { ...run, workspace: { ...run.workspace, mode: "cwd" as const } };
    expect(tryOutOf(rt, cwd)).toBeUndefined();
  });

  it("cd keeps ~ outside the quotes", () => {
    expect(cdTo("~/.jarvis/worktrees/web/a")).toBe("cd ~/.jarvis/worktrees/web/a");
    expect(cdTo("~/My Repos/web")).toBe('cd ~/"My Repos/web"');
    expect(cdTo("/srv/a b")).toBe('cd "/srv/a b"');
  });
});
