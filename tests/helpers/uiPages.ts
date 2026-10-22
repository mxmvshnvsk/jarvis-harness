import { Writable } from "node:stream";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { run as cli } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "./tmp.ts";

/**
 * A `jarvis ui` with the pages a person works on, filled: two runs waiting at a spec's gate — one with
 * open questions (the decision under them), one long without (the side column) — so the Runs page has
 * its dock. For the layout and structure checks of tests/ui/layout*.test.ts.
 */
export interface UiPages {
  readonly sb: Sandbox;
  readonly rt: Runtime;
  readonly ui: UiServer;
  /** Page paths by name: runs, run, questions, review, knowledge. */
  readonly paths: Readonly<Record<string, string>>;
  readonly url: (path: string) => string;
  readonly get: (path: string) => Promise<string>;
  close(): Promise<void>;
}

const long = (n: number, text: string) => Array.from({ length: n }, (_v, i) => `${text} ${i + 1}`);

const QUESTIONS = JSON.stringify({
  title: "Delivery slots",
  summary: "Slots on the order form, from logistics-api, with the window in the SMS.",
  goals: long(14, "A goal that is long enough to wrap on a narrow screen of a phone, number"),
  requirements: long(18, "Slots come from logistics-api and show on the order form, requirement").map(
    (text, i) => ({ id: `R${i + 1}`, text }),
  ),
  openQuestions: [
    {
      question: "Remove the analytics events with the banner?",
      about: "the banner analytics",
      options: ["Remove them with the banner", "Keep them as historical", "Remove and warn analytics"],
    },
    "Update the page spec here or later? (page «Services») — Here / In a task of its own / Never",
    "The exact wording of the delivery terms?",
  ],
});

const REVIEW = JSON.stringify({
  title: "Order form: phone mask",
  summary: "The phone field of the order form takes a mask. ".repeat(12),
  goals: long(30, "A goal of the change, number"),
  requirements: long(24, "The mask applies to the phone field, requirement").map((text, i) => ({
    id: `R${i + 1}`,
    text,
  })),
});

const gated = (name: string, content: string) => `name: ${name}
entry: write
steps:
  - id: write
    kind: deterministic
    tool: artifact.write
    args: { type: spec, name: spec.json, content: '${content}' }
    outputs: [spec]
    transitions: { onSuccess: approve }
  - id: approve
    kind: approval
    artifactType: spec
    transitions: { onSuccess: DONE }
`;

export async function uiPages(): Promise<UiPages> {
  const sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write("project/.jarvis/workflows/gq.yaml", gated("gq", QUESTIONS));
  sb.write("project/.jarvis/workflows/gs.yaml", gated("gs", REVIEW));
  const sink = () => new Writable({ write: (_c, _e, cb) => cb() });
  const context = {
    cwd: sb.project,
    homeDir: sb.home,
    env: { PATH: process.env.PATH ?? "", JARVIS_INTERACTIVE: "off" },
  };
  for (const [task, wf] of [
    ["ABC-42 delivery slots on the order form", "gq"],
    ["ABC-43 a phone mask on the order form", "gs"],
  ] as const)
    await cli(["node", "jarvis", "work", task, "--workflow", wf], {
      streams: { out: sink(), err: sink() },
      context,
    });
  const rt = createRuntime(await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} }), { env: {} });
  const ui = await startUiServer({
    runtime: rt,
    engine: createEngine(rt),
    port: 0,
    homeDir: sb.home,
    projectRoot: sb.project,
    pollMs: 100,
    actor: async () => ({ kind: "user", id: "dev@example.com", verified: false }),
    open: () => "VS Code",
  });
  const runs = rt.runs.list({ includeTerminal: true });
  const short = (wf: string) => runs.find((r) => r.workflow === wf)?.id.slice(4, 12) ?? "";
  const paths = {
    runs: "/",
    run: `/runs/${short("gq")}`,
    questions: `/runs/${short("gq")}/artifacts/spec/spec.json`,
    review: `/runs/${short("gs")}/artifacts/spec/spec.json`,
    knowledge: "/knowledge",
  };
  const url = (path: string) => `http://127.0.0.1:${ui.port}${path}`;
  return {
    sb,
    rt,
    ui,
    paths,
    url,
    get: (path) =>
      fetch(url(path), {
        headers: { cookie: `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}` },
      }).then((r) => r.text()),
    async close() {
      await ui.close();
      await rt.close();
      sb.cleanup();
    },
  };
}
