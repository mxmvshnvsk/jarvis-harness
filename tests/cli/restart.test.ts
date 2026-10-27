import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { redoNotesFor } from "../../src/app/redo.ts";
import { mainCourse, restartPlanOf, writesCode } from "../../src/app/restart.ts";
import { createRuntime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import type { Launcher } from "../../src/ui/launcher.ts";
import { runPage } from "../../src/ui/model.ts";
import { restartChoiceHtml, runContent } from "../../src/ui/pages.ts";
import { startUiServer } from "../../src/ui/server.ts";
import { loadWorkflows } from "../../src/workflows/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** `jarvis restart`: a stopped run again from one of its steps, with what it did before it. */
let sb: Sandbox;

const write = (id: string, type: string, next: string) => `  - id: ${id}
    kind: deterministic
    tool: artifact.write
    args: { type: ${type}, name: ${type}.md, content: "# ${type}" }
    outputs: [${type}]
    transitions: { onSuccess: ${next} }
`;

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write(
    "project/.jarvis/workflows/staged.yaml",
    `name: staged
entry: research
steps:
${write("research", "research", "spec")}${write("spec", "spec", "approve-spec")}  - id: approve-spec
    kind: approval
    artifactType: spec
    transitions: { onSuccess: impact }
${write("impact", "impact", "approve-impact")}  - id: approve-impact
    kind: approval
    artifactType: impact
    transitions: { onSuccess: plan }
${write("plan", "plan", "DONE")}`,
  );
});
afterEach(() => sb.cleanup());

async function jarvis(args: string[]) {
  let out = "";
  let err = "";
  const sink = (f: (s: string) => void) =>
    new Writable({
      write(c, _e, cb) {
        f(String(c));
        cb();
      },
    });
  const code = await run(["node", "jarvis", ...args], {
    streams: { out: sink((s) => (out += s)), err: sink((s) => (err += s)) },
    context: {
      cwd: sb.project,
      homeDir: sb.home,
      env: { PATH: process.env.PATH ?? "", JARVIS_INTERACTIVE: "off" },
    },
  });
  return { code, out, err };
}

async function runs() {
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  const rt = createRuntime(loaded, { env: {} });
  try {
    const list = rt.runs
      .list({ includeTerminal: true })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return list.map((r) => ({
      run: r,
      types: rt.artifacts
        .listLatest(r.id)
        .map((a) => a.type)
        .sort(),
      approved: rt.artifacts
        .listLatest(r.id)
        .filter((a) => rt.artifacts.approvalsFor(a.artifactId, a.version)[0]?.decision === "approve")
        .map((a) => a.type),
    }));
  } finally {
    rt.close();
  }
}

/** A run that approved its spec, analysed the impact and was cancelled at the impact's approval. */
async function cancelledAtImpact(): Promise<string> {
  const first = await jarvis(["work", "ABC-42", "--workflow", "staged"]);
  expect(first.code).toBe(10);
  const id = ((await runs())[0]?.run.id ?? "").slice(4, 12);
  expect((await jarvis(["approve", id, "--resume"])).code).toBe(10);
  expect((await jarvis(["cancel", id])).code).toBe(0);
  expect((await runs())[0]?.run.state).toBe("CANCELLED");
  return id;
}

describe("jarvis restart", () => {
  it("by default starts right after the last approval, with the approved spec and what came before", async () => {
    const id = await cancelledAtImpact();
    const r = await jarvis(["restart", id, "--no-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/✓ spec\s+approved, taken on/);
    expect(r.out).toMatch(/→ impact\s+starts here/);
    const [, again] = await runs();
    expect(again?.run.currentStep).toBe("impact");
    expect(again?.types).toEqual(["research", "spec"]);
    expect(again?.approved).toEqual(["spec"]);
    // that run cancelled before it began: what it took on can be taken on again (pilot: «nothing»)
    const second = (again?.run.id ?? "").slice(4, 12);
    expect((await jarvis(["cancel", second])).code).toBe(0);
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    try {
      const run2 = rt.runs.get(again?.run.id ?? "");
      const staged = loadWorkflows(sb.project).get("staged");
      if (!run2 || !staged) throw new Error("no run");
      const plan = restartPlanOf(rt, run2, staged);
      expect(plan?.steps.filter((x) => x.startable).map((x) => x.id)).toEqual([
        "research",
        "spec",
        "approve-spec",
        "impact",
      ]);
      expect(plan?.steps.find((x) => x.id === "spec")?.approved).toBe(true);
    } finally {
      rt.close();
    }
  });

  it("--from a later step takes the impact on too; it goes on to the end without asking for the spec again", async () => {
    const id = await cancelledAtImpact();
    const r = await jarvis(["restart", id, "--from", "approve-impact"]);
    expect(r.code).toBe(10);
    const [, again] = await runs();
    expect(again?.types).toEqual(["impact", "research", "spec"]);
    expect(again?.run.currentStep).toBe("approve-impact");
    const short = (again?.run.id ?? "").slice(4, 12);
    expect((await jarvis(["approve", short, "--resume"])).code).toBe(0);
    expect((await runs())[1]?.run.state).toBe("COMPLETED");
  });

  it("a step past what the run did is refused, and so is a run that still goes on", async () => {
    const id = await cancelledAtImpact();
    const late = await jarvis(["restart", id, "--from", "plan"]);
    expect(late.code).not.toBe(0);
    expect(late.err).toContain('cannot start at "plan"');
    await jarvis(["work", "ABC-43", "--workflow", "staged"]);
    const waiting = ((await runs()).at(-1)?.run.id ?? "").slice(4, 12);
    const busy = await jarvis(["restart", waiting]);
    expect(busy.code).not.toBe(0);
    expect(busy.err).toContain("WAITING_HUMAN");
  });

  it("the page of the cancelled run: «Start again from» with the steps, the recommended one first in line", async () => {
    await cancelledAtImpact();
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    try {
      const cancelled = rt.runs.list({ includeTerminal: true })[0];
      if (!cancelled) throw new Error("no run");
      const page = await runPage(rt, createEngine(rt), cancelled, { homeDir: sb.home });
      expect(page.restart?.startAt).toBe("impact");
      const html = String(runContent(page, Date.now(), { token: "t", canLaunch: true }));
      expect(html).toContain("Start again from");
      expect(html).toContain(`/runs/${cancelled.id.slice(4, 12)}/restart`);
      expect(html).toContain('<input type="radio" name="step" value="impact" checked>');
      expect(html).toContain('name="note"');
      expect(html).toContain("— research, spec go in (spec approved)");
      // New task for the same issue: its earlier runs, the newest open; a gate is no start
      const hint = String(
        restartChoiceHtml([{ run: cancelled, plan: page.restart as NonNullable<typeof page.restart> }]),
      );
      expect(hint).toContain("This task ran here before");
      expect(hint).toContain(`value="${cancelled.id.slice(4, 12)}:impact" data-step="impact" checked`);
      expect(hint).toContain("— research, spec go in (spec approved)");
      expect(hint).not.toContain(':approve-spec"');
      expect(hint).toContain('name="from-mode" value="step" checked');
      // stopped at a gate it was sent back from: the step before it is recommended, not «nothing»
      const atGate = {
        workflow: "staged",
        startAt: "approve-spec",
        steps: [
          { id: "research", kind: "deterministic" as const, done: true, approved: false, startable: true },
          { id: "spec", kind: "deterministic" as const, done: true, approved: false, startable: true },
          { id: "approve-spec", kind: "approval" as const, done: false, approved: false, startable: true },
          { id: "impact", kind: "deterministic" as const, done: false, approved: false, startable: false },
        ],
      };
      expect(String(restartChoiceHtml([{ run: cancelled, plan: atGate }]))).toContain(
        `value="${cancelled.id.slice(4, 12)}:spec" data-step="spec" checked`,
      );
      // none to take anything on from: nothing is said; beside one that has, it says so
      expect(String(restartChoiceHtml([{ run: cancelled }]))).toBe("");
      expect(
        String(
          restartChoiceHtml([
            { run: cancelled, plan: page.restart as NonNullable<typeof page.restart> },
            { run: cancelled },
          ]),
        ),
      ).toContain("nothing to take on");
    } finally {
      rt.close();
    }
  });

  it("sdd: nothing past the first step that writes code is taken on", () => {
    const sdd = loadWorkflows(sb.project).get("sdd");
    if (!sdd) throw new Error("no sdd");
    const writing = mainCourse(sdd)
      .filter((s) => writesCode(s, sdd))
      .map((s) => s.id);
    expect(writing[0]).toBe("implementation");
    const impact = sdd.steps.find((s) => s.id === "impact");
    expect(impact && writesCode(impact, sdd)).toBe(false);
  });
});

describe("jarvis redo", () => {
  it("a waiting run goes back to a step it went through, with a note for that round; the steps after it run again", async () => {
    await jarvis(["work", "ABC-50", "--workflow", "staged"]);
    const [first] = await runs();
    const id = (first?.run.id ?? "").slice(4, 12);
    expect(first?.run.currentStep).toBe("approve-spec");
    const r = await jarvis(["redo", id, "research", "--note", "look at the address handler too"]);
    expect(r.out).toContain("goes back to research");
    expect(r.code).toBe(10);
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    try {
      const run = rt.runs.get(first?.run.id as string);
      expect(run?.currentStep).toBe("approve-spec");
      const rounds = rt.history
        .list(run?.id as string)
        .filter((h) => h.stepId === "research")
        .map((h) => h.iteration);
      expect(rounds).toEqual([1, 2]);
      expect(redoNotesFor(rt, run?.id as string, "research", 2).map((n) => n.note)).toEqual([
        "look at the address handler too",
      ]);
      expect(redoNotesFor(rt, run?.id as string, "spec", 2)).toEqual([]);
      // the spec was written again: a new version waits for approval
      expect(rt.artifacts.listLatest(run?.id as string, "spec")[0]?.version).toBe(2);
    } finally {
      rt.close();
    }
  });

  it("the page of a waiting run: «Redo from a step» with the steps it went through", async () => {
    await jarvis(["work", "ABC-52", "--workflow", "staged"]);
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    try {
      const waiting = rt.runs.list({ includeTerminal: true })[0];
      if (!waiting) throw new Error("no run");
      const page = await runPage(rt, createEngine(rt), waiting, { homeDir: sb.home });
      expect(page.redo).toEqual({ targets: ["research", "spec", "approve-spec"], current: "approve-spec" });
      const html = String(runContent(page, Date.now(), { token: "t", canLaunch: true }));
      expect(html).toContain("Redo from a step…");
      expect(html).toContain(`/runs/${waiting.id.slice(4, 12)}/redo`);
      expect(html).toContain('<option value="approve-spec" selected>approve-spec (now)</option>');
    } finally {
      rt.close();
    }
  });

  it("a subtask goes back in place, as any run; an ended one is sent to `jarvis subtask retry`", async () => {
    await jarvis(["work", "ABC-53", "--workflow", "staged"]);
    const [first] = await runs();
    const runId = first?.run.id as string;
    const id = runId.slice(4, 12);
    // a subtask of a master (pilot: «cad… is subtask 3 of d1…» refused a redo in place)
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const parent = { runId: "run_00000000aaaaaaaaaaaa", key: "3" };
    (rt.runs as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE runs SET options_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...(first?.run.options ?? {}), parent }), runId);
    rt.close();
    const r = await jarvis(["redo", id, "research", "--note", "remove the folder"]);
    expect(r.err).not.toContain("is subtask");
    expect(r.out).toContain("goes back to research");
    await jarvis(["cancel", id]);
    const ended = await jarvis(["redo", id, "research"]);
    expect(ended.code).not.toBe(0);
    expect(ended.err).toContain(
      `${id} is subtask 3 of 00000000 and has ended: \`jarvis subtask retry 00000000 3\``,
    );
  });

  it("a step the run never reached is refused", async () => {
    await jarvis(["work", "ABC-51", "--workflow", "staged"]);
    const id = ((await runs())[0]?.run.id ?? "").slice(4, 12);
    const r = await jarvis(["redo", id, "plan"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('"plan" is not a step this run went through');
  });

  it("an ended run starts again from the step as a new run, the note for its first round", async () => {
    const id = await cancelledAtImpact();
    const r = await jarvis(["redo", id, "spec", "--note", "one restart only", "--no-run"]);
    expect(r.code).toBe(0);
    const [, again] = await runs();
    expect(again?.run.currentStep).toBe("spec");
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    try {
      expect(redoNotesFor(rt, again?.run.id as string, "spec", 1).map((n) => n.note)).toEqual([
        "one restart only",
      ]);
    } finally {
      rt.close();
    }
  });

  it("New task: a step of an earlier run of the same task starts it there (a gate is no start)", async () => {
    // the same steps as the page's Specification: a project's spec.yaml stands for the built-in one
    sb.write(
      "project/.jarvis/workflows/spec.yaml",
      readFileSync(join(sb.project, ".jarvis", "workflows", "staged.yaml"), "utf8").replace(
        "name: staged",
        "name: spec",
      ),
    );
    const first = await jarvis(["work", "ABC-42", "--workflow", "spec"]);
    expect(first.code).toBe(10);
    const id = ((await runs())[0]?.run.id ?? "").slice(4, 12);
    expect((await jarvis(["approve", id, "--resume"])).code).toBe(10);
    expect((await jarvis(["cancel", id])).code).toBe(0);
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const asked: Array<{ run: string; step: string; note?: string }> = [];
    const launcher = {
      restartRun: (from: { id: string }, step: string, note?: string) => {
        asked.push({ run: from.id, step, ...(note ? { note } : {}) });
        return { id: "l1" };
      },
      list: () => [],
      tend: () => {},
      drives: () => false,
    } as unknown as Launcher;
    const ui = await startUiServer({
      runtime: rt,
      engine: createEngine(rt),
      port: 0,
      homeDir: sb.home,
      projectRoot: sb.project,
      pollMs: 30,
      mcpCheckEveryMs: 0,
      actor: async () => ({ kind: "user" as const, id: "me@corp", verified: false }),
      launcher,
    });
    try {
      const cookie = `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}`;
      const box = await (
        await fetch(
          `http://127.0.0.1:${ui.port}/runs/from?${new URLSearchParams({ task: "ABC-42", workflow: "spec", repo: sb.project })}`,
          { headers: { cookie } },
        )
      ).text();
      expect(box).toContain("This task ran here before");
      expect(box).toContain(`value="${id}:impact" data-step="impact" checked`);
      expect(box).not.toContain(`value="${id}:approve-spec"`);
      const post = (fields: Record<string, string>) =>
        fetch(`http://127.0.0.1:${ui.port}/runs/new`, {
          method: "POST",
          redirect: "manual",
          headers: {
            cookie,
            origin: `http://127.0.0.1:${ui.port}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            t: ui.token,
            task: "ABC-42",
            workflow: "spec",
            repo: sb.project,
            ...fields,
          }),
        });
      const gate = await post({ "from-mode": "step", restart: `${id}:approve-spec` });
      expect(gate.status, await gate.clone().text()).toBe(303);
      expect(gate.headers.get("location")).toContain("notice=cannot-continue");
      const ok = await post({ "from-mode": "step", restart: `${id}:impact`, "restart-note": "smaller" });
      expect(ok.headers.get("location")).toBe("/launches/l1");
      expect(asked).toEqual([{ run: expect.stringContaining(id), step: "impact", note: "smaller" }]);
    } finally {
      await ui.close();
      rt.close();
    }
  });
});
