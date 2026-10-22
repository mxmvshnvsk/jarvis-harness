import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime } from "../../src/app/runtime.ts";
import { deliveryOrder, setCliLauncher, subtasksOf } from "../../src/app/subtasks.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { forgetLayouts } from "../../src/core/paths.ts";
import { runPage } from "../../src/ui/model.ts";
import { runContent } from "../../src/ui/pages.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/**
 * ADR-0025 §6: a task across services — the master in the knowledge repository splits it, the
 * subtasks run in the services' repositories, the master waits for them and checks the contract.
 * The models' steps are replaced by fixed artifacts; the subtasks' processes run in this one.
 */
let sb: Sandbox;
let repos: string;
let meta: string;
let launches: Array<{ args: readonly string[]; cwd: string }>;

const SPLIT = JSON.stringify({
  summary: "orders-api sends the slot, notify-api shows it",
  subtasks: [
    { key: "1", service: "orders-api", task: "Put deliverySlotId into orders.created", requirements: ["R1"] },
    {
      key: "2",
      service: "notify-api",
      task: "Show the slot window in the SMS",
      requirements: ["R2"],
      deliverAfter: ["1"],
    },
  ],
  contract: [
    {
      kind: "topic",
      id: "orders.created",
      change: "+ deliverySlotId, optional",
      producer: "orders-api",
      consumers: ["notify-api"],
    },
  ],
});

/** The master's workflow with the models' steps as fixed artifacts. */
const MASTER = `name: sdd-cross
entry: spec
steps:
  - id: spec
    kind: deterministic
    tool: artifact.write
    args: { type: spec, name: spec.json, content: '{"title":"Delivery slot","requirements":[]}' }
    outputs: [spec]
    transitions: { onSuccess: split }
  - id: split
    kind: deterministic
    tool: artifact.write
    args: { type: split, name: split.json, content: '${SPLIT}' }
    outputs: [split]
    transitions: { onSuccess: spawn }
  - id: spawn
    kind: deterministic
    tool: cross.spawn
    transitions: { onSuccess: wait }
  - id: wait
    kind: deterministic
    tool: cross.wait
    transitions: { onSuccess: contract-check }
  - id: contract-check
    kind: deterministic
    tool: cross.check
    outputs: [contract-check]
    transitions: { onSuccess: approve-delivery }
  - id: approve-delivery
    kind: approval
    artifactType: contract-check
    transitions: { onSuccess: DONE }
`;

/** A subtask's sdd from its impact, as fixed artifacts. */
const SUBTASK = `name: sdd
entry: impact
steps:
  - id: impact
    kind: deterministic
    tool: artifact.write
    args: { type: impact, name: impact.json, content: '{"affected":[]}' }
    outputs: [impact]
    transitions: { onSuccess: DONE }
`;

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

function repo(name: string): string {
  const dir = join(repos, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

beforeEach(() => {
  forgetLayouts();
  sb = sandbox();
  repos = join(sb.root, "repos");
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  meta = repo("jarvis-knowledge");
  sb.write(
    "repos/jarvis-knowledge/.jarvis/project.yaml",
    "version: 1\nworkspace: { mode: cwd }\ncrossRepos: { maxParallel: 1 }\nservices:\n  orders-api: {}\n  notify-api: {}\n",
  );
  sb.write("repos/jarvis-knowledge/.jarvis/workflows/sdd-cross.yaml", MASTER);
  sb.write("repos/jarvis-knowledge/.jarvis/workflows/sdd.yaml", SUBTASK);
  repo("orders-api");
  repo("notify-api");
  launches = [];
  setCliLauncher(({ args, cwd }) => launches.push({ args, cwd }));
});
afterEach(() => {
  setCliLauncher(undefined);
  forgetLayouts();
  sb.cleanup();
});

async function jarvis(cwd: string, args: readonly string[]) {
  let out = "";
  const sink = new Writable({
    write(c, _e, cb) {
      out += String(c);
      cb();
    },
  });
  const code = await run(["node", "jarvis", ...args], {
    streams: { out: sink, err: sink },
    context: { cwd, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", JARVIS_INTERACTIVE: "off" } },
  });
  return { code, out };
}

/** The next process the master or a subtask started, run here. */
async function next() {
  const l = launches.shift();
  if (!l) throw new Error("nothing was started");
  return { ...l, result: await jarvis(l.cwd, l.args) };
}

describe("a task across services", () => {
  it("splits, runs the subtasks one by one in their repositories, then the master checks the contract", async () => {
    const master = await jarvis(meta, [
      "--json",
      "work",
      "ABC-42 delivery slot in the order event",
      "--workflow",
      "sdd-cross",
    ]);
    // the master parks waiting for its subtasks; the first one (of one slot) is started in orders-api
    expect(master.out).toContain("SUSPENDED");
    expect(launches.map((l) => [l.args.slice(0, 2).join(" "), l.args[3], l.cwd])).toEqual([
      ["subtask run", "1", join(repos, "orders-api")],
    ]);

    const first = await next();
    expect(first.result.code).toBe(0);
    // its slot freed: the second starts
    expect(launches.map((l) => [l.args[3], l.cwd])).toEqual([["2", join(repos, "notify-api")]]);
    const second = await next();
    expect(second.result.code).toBe(0);
    // every subtask done: the master goes on in the knowledge repository
    expect(launches.map((l) => [l.args[0], l.cwd])).toEqual([["resume", meta]]);
    const resumed = await next();
    expect(resumed.result.code).toBe(10); // the delivery gate

    let childId: string | undefined;
    const loaded = await loadConfig({ cwd: meta, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    try {
      const m = rt.runs.list({ includeTerminal: true }).find((r) => r.workflow === "sdd-cross");
      if (!m) throw new Error("no master");
      expect(m.state).toBe("WAITING_HUMAN");
      const views = subtasksOf(rt, m);
      expect(views.map((v) => [v.subtask.key, v.subtask.service, v.state])).toEqual([
        ["1", "orders-api", "COMPLETED"],
        ["2", "notify-api", "COMPLETED"],
      ]);
      // the subtask's run knows its part and the contract
      expect(views[1]?.run?.task).toContain("subtask 2 of 2, notify-api");
      childId = views[1]?.run?.id;
      expect(views[1]?.run?.task).toContain(
        "topic orders.created: + deliverySlotId, optional — orders-api sends; notify-api read",
      );
      const check = JSON.parse(
        rt.artifacts.text(rt.artifacts.listLatest(m.id, "contract-check")[0] as never),
      ) as {
        ok: boolean;
        items: Array<{ producerSide: { service: string; status: string } }>;
      };
      // the code does not send the topic: the check says so, no model involved
      expect(check.items[0]?.producerSide).toEqual({ service: "orders-api", status: "missing" });
      expect(check.ok).toBe(false);
      // the master's page: its subtasks and the contract, each side
      const page = await runPage(rt, createEngine(rt), m, { homeDir: sb.home });
      const body = runContent(page, Date.now()).value;
      expect(body).toContain("Subtasks");
      expect(body).toContain("2 of 2 done");
      expect(body).toContain("✗ orders-api");
      const child = await runPage(rt, createEngine(rt), views[1]?.run as never, { homeDir: sb.home });
      expect(runContent(child, Date.now()).value).toContain("subtask 2 of 2 · notify-api of");
    } finally {
      rt.close();
    }

    const masterId = second.args[2] as string;
    const masterStatus = await jarvis(meta, ["status", masterId.slice(4, 12)]);
    expect(masterStatus.out).toMatch(/subtasks\s+1 orders-api\s+COMPLETED/);
    const childStatus = await jarvis(join(repos, "notify-api"), ["status", (childId as string).slice(4, 12)]);
    expect(childStatus.out).toMatch(/subtask\s+2 of 2 · notify-api of ABC-42/);
    const list = await jarvis(meta, ["subtask", "list", (second.args[2] as string).slice(4, 12)]);
    expect(list.out).toMatch(/1\s+orders-api\s+COMPLETED/);
  });

  it("a subtask dropped by a person: the master goes on without it", async () => {
    await jarvis(meta, ["work", "ABC-43", "--workflow", "sdd-cross"]);
    const masterId = launches[0]?.args[2] as string;
    await next(); // orders-api completes; notify-api is started
    launches.length = 0;
    const dropped = await jarvis(meta, ["subtask", "drop", masterId.slice(4, 12), "notify-api"]);
    expect(dropped.code).toBe(0);
    expect(launches.map((l) => l.args[0])).toEqual(["resume"]);
  });

  it("delivers the producer before its consumers", () => {
    const order = deliveryOrder([
      { key: "1", service: "notify-api", task: "", requirements: [], deliverAfter: ["2"] },
      { key: "2", service: "orders-api", task: "", requirements: [], deliverAfter: [] },
    ]);
    expect(order.map((s) => s.service)).toEqual(["orders-api", "notify-api"]);
  });

  it("refuses to run in a service: the master's place is the knowledge repository", async () => {
    const r = await jarvis(join(repos, "orders-api"), ["work", "ABC-44", "--workflow", "sdd-cross"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("runs in the knowledge repository");
  });
});

describe("a library in a task across services", () => {
  const LIB_SPLIT = JSON.stringify({
    summary: "round amounts once",
    subtasks: [
      { key: "1", service: "common-lib", task: "Add Money.round()", requirements: ["R1"] },
      {
        key: "2",
        service: "orders-api",
        task: "Round the total once",
        requirements: ["R2"],
        deliverAfter: ["1"],
      },
      { key: "3", service: "notify-api", task: "Say the amount", requirements: ["R3"] },
    ],
    contract: [],
  });
  const map = (publish: string) =>
    [
      "version: 1",
      "workspace: { mode: cwd }",
      "crossRepos: { maxParallel: 2 }",
      "services:",
      "  common-lib:",
      "    kind: library",
      "    publishes: [com.example:common-lib]",
      `    tools: { local: { publish-local: "${publish}" } }`,
      "  orders-api:",
      "    uses: [common-lib]",
      "  notify-api: {}",
      "",
    ].join("\n");

  beforeEach(() => {
    sb.write(
      "repos/jarvis-knowledge/.jarvis/workflows/sdd-cross.yaml",
      MASTER.replace(`'${SPLIT}'`, `'${LIB_SPLIT}'`),
    );
    repo("common-lib");
    sb.write("repos/common-lib/gradle.properties", "version=2.15.0\n");
  });

  it("who uses it starts once its change is accepted and published, against that version", async () => {
    sb.write("repos/jarvis-knowledge/.jarvis/project.yaml", map("echo published > published.txt"));
    await jarvis(meta, ["work", "ABC-57 round amounts", "--workflow", "sdd-cross"]);
    // the library and the service that does not use it start; orders-api waits
    expect(launches.map((l) => [l.args[3], l.cwd])).toEqual([
      ["1", join(repos, "common-lib")],
      ["3", join(repos, "notify-api")],
    ]);
    const masterId = launches[0]?.args[2] as string;
    const loaded = await loadConfig({ cwd: meta, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    try {
      const m = rt.runs.get(masterId);
      const views = subtasksOf(rt, m as never);
      expect(views.find((v) => v.subtask.key === "2")).toMatchObject({ state: "blocked", waitsFor: ["1"] });
      // the master's page: who waits for what, and starting it anyway
      const body = runContent(
        await runPage(rt, createEngine(rt), m as never, { homeDir: sb.home }),
        Date.now(),
      ).value;
      expect(body).toContain("waits for common-lib</span>");
      expect(body).toContain("Starts when common-lib is accepted and published, against the new version.");
    } finally {
      rt.close();
    }
    const lib = await next();
    expect(lib.result.code).toBe(0);
    // accepted (its run completed): published in its checkout, then orders-api starts
    expect(readFileSync(join(repos, "common-lib", "published.txt"), "utf8")).toBe("published\n");
    expect(launches.map((l) => [l.args[3], l.cwd])).toEqual([
      ["3", join(repos, "notify-api")],
      ["2", join(repos, "orders-api")],
    ]);
    launches.shift();
    const orders = await next();
    expect(orders.result.code).toBe(0);
    const rt2 = createRuntime(await loadConfig({ cwd: meta, homeDir: sb.home, env: {} }), { env: {} });
    try {
      const v = subtasksOf(rt2, rt2.runs.get(masterId) as never);
      expect(v.find((x) => x.subtask.key === "1")?.published).toMatchObject({
        ok: true,
        version: "2.15.0",
        command: "echo published > published.txt",
      });
      const task = v.find((x) => x.subtask.key === "2")?.run?.task ?? "";
      expect(task).toContain("Libraries this service uses that the task changed first");
      expect(task).toContain(
        "- common-lib (subtask 1): Add Money.round() — the dependency to move: com.example:common-lib — version 2.15.0, published on this machine by `echo published > published.txt`",
      );
    } finally {
      rt2.close();
    }
    const list = await jarvis(meta, ["subtask", "list", masterId.slice(4, 12)]);
    expect(list.out).toMatch(/1\s+common-lib\s+COMPLETED.*published 2\.15\.0/);
  });

  it("publish-local failed: the services keep waiting; a person starts one anyway, or publishes again", async () => {
    sb.write("repos/jarvis-knowledge/.jarvis/project.yaml", map("echo no network; exit 3"));
    await jarvis(meta, ["work", "ABC-58 round amounts", "--workflow", "sdd-cross"]);
    const masterId = launches[0]?.args[2] as string;
    await next(); // the library completes, its publish fails
    expect(launches.map((l) => l.args[3])).toEqual(["3"]);
    const list = await jarvis(meta, ["subtask", "list", masterId.slice(4, 12)]);
    expect(list.out).toMatch(/2\s+orders-api\s+blocked.*waits for 1 to be accepted and published/);
    expect(list.out).toContain("publish-local failed");
    const rt = createRuntime(await loadConfig({ cwd: meta, homeDir: sb.home, env: {} }), { env: {} });
    try {
      const m = rt.runs.get(masterId);
      const body = runContent(
        await runPage(rt, createEngine(rt), m as never, { homeDir: sb.home }),
        Date.now(),
      ).value;
      expect(body).toContain("<b>publish-local failed</b>");
      expect(body).toContain("no network");
      expect(body).toContain("Start now anyway");
    } finally {
      rt.close();
    }
    // again, in the library's repository: still failing, said with its output
    const again = await jarvis(join(repos, "common-lib"), ["subtask", "publish", masterId.slice(4, 12), "1"]);
    expect(again.code).toBe(1);
    expect(again.out).toContain("no network");
    launches.length = 0;
    const started = await jarvis(meta, ["subtask", "start", masterId.slice(4, 12), "orders-api"]);
    expect(started.code).toBe(0);
    expect(started.out).toContain("without waiting for its libraries");
    expect(launches.map((l) => l.args[3])).toEqual(["2"]);
  });
});

/** Opens the runtime of the knowledge repository for a look at the master and its subtasks. */
async function knowledgeRuntime() {
  return createRuntime(await loadConfig({ cwd: meta, homeDir: sb.home, env: {} }), { env: {} });
}

describe("the fields of the contract's DTOs", () => {
  const DTO_SPLIT = JSON.stringify({
    summary: "the slot in the event",
    subtasks: [
      { key: "1", service: "orders-api", task: "Send the slot", requirements: ["R1"] },
      { key: "2", service: "notify-api", task: "Read the slot", requirements: ["R2"], deliverAfter: ["1"] },
    ],
    contract: [
      {
        kind: "dto",
        id: "OrderCreatedEvent",
        change: "+ deliverySlotId",
        producer: "orders-api",
        consumers: ["notify-api"],
      },
    ],
  });

  it("compares the producer's and the consumer's DTO field by field, in their checkouts", async () => {
    sb.write(
      "repos/jarvis-knowledge/.jarvis/workflows/sdd-cross.yaml",
      MASTER.replace(`'${SPLIT}'`, `'${DTO_SPLIT}'`),
    );
    sb.write(
      "repos/orders-api/src/main/java/com/example/orders/OrderCreatedEvent.java",
      "package com.example.orders;\n\n@Data\npublic class OrderCreatedEvent {\n  private String orderId;\n  private Long deliverySlotId;\n  private BigDecimal total;\n}\n",
    );
    sb.write(
      "repos/notify-api/src/main/kotlin/com/example/notify/OrderCreatedEvent.kt",
      'package com.example.notify\n\ndata class OrderCreatedEvent(\n  val orderId: String,\n  @JsonProperty("slot_id") val deliverySlotId: Long?,\n  val total: String,\n  val channel: String,\n)\n',
    );
    await jarvis(meta, ["work", "ABC-60 slot in the event", "--workflow", "sdd-cross"]);
    await next();
    await next();
    const resumed = await next();
    expect(resumed.result.code).toBe(10);
    const rt = await knowledgeRuntime();
    try {
      const m = rt.runs.list({ includeTerminal: true }).find((r) => r.workflow === "sdd-cross");
      const check = JSON.parse(
        rt.artifacts.text(rt.artifacts.listLatest(m?.id as string, "contract-check")[0] as never),
      ) as {
        ok: boolean;
        items: Array<{
          producerSide: { status: string; at?: string };
          consumerSides: Array<{
            status: string;
            fields?: Array<{
              role: string;
              writer: string;
              reader: string;
              fields?: Array<Record<string, string>>;
            }>;
          }>;
        }>;
      };
      const item = check.items[0];
      expect(item?.producerSide).toMatchObject({
        status: "ok",
        at: "src/main/java/com/example/orders/OrderCreatedEvent.java:4",
      });
      const consumer = item?.consumerSides[0];
      expect(consumer?.status).toBe("mismatch");
      expect(check.ok).toBe(false);
      expect(consumer?.fields?.[0]).toMatchObject({
        role: "dto",
        writer: "orders-api",
        reader: "notify-api",
      });
      expect(consumer?.fields?.[0]?.fields?.map((f) => [f.field, f.change, f.status])).toEqual([
        ["channel", "removed", "mismatch"],
        ["orderId", "same", "ok"],
        ["slot_id → deliverySlotId", "renamed", "mismatch"],
        ["total", "type changed", "mismatch"],
      ]);
      // the master's card: the fields, with what changed and whether it holds
      const body = runContent(
        await runPage(rt, createEngine(rt), m as never, { homeDir: sb.home }),
        Date.now(),
      ).value;
      expect(body).toContain("≠ notify-api");
      expect(body).toContain("<code>slot_id → deliverySlotId</code></td><td>renamed</td>");
      expect(body).toContain("<td>type changed</td>");
    } finally {
      rt.close();
    }
  });
});

describe("a subtask asks to change the contract", () => {
  const ASKS = `name: sdd
entry: impact
steps:
  - id: impact
    kind: deterministic
    tool: artifact.write
    args: { type: impact, name: impact.json, content: '{"affected":[],"contractChange":{"item":"orders.created","change":"+ deliverySlotId, required","why":"every order has a slot here"}}' }
    outputs: [impact]
    transitions: { onSuccess: DONE }
`;

  it("parks; the master's page asks; accepted — a new split, the impact again; rejected — on as agreed", async () => {
    sb.write("repos/jarvis-knowledge/.jarvis/workflows/sdd.yaml", ASKS);
    await jarvis(meta, ["work", "ABC-61 delivery slot", "--workflow", "sdd-cross"]);
    const masterId = launches[0]?.args[2] as string;
    const short = masterId.slice(4, 12);
    const first = await next();
    expect(first.result.out).toContain("WAITING_HUMAN");
    // waiting for a person does not hold a slot: the next subtask starts
    expect(launches.map((l) => l.args[3])).toEqual(["2"]);
    launches.length = 0;

    let rt = await knowledgeRuntime();
    let subId: string;
    try {
      const sub = subtasksOf(rt, rt.runs.get(masterId) as never)[0]?.run;
      subId = sub?.id as string;
      expect(sub?.waitingFor).toMatchObject({ kind: "contract", detail: "orders.created" });
      const body = runContent(
        await runPage(rt, createEngine(rt), rt.runs.get(masterId) as never, { homeDir: sb.home }),
        Date.now(),
      ).value;
      expect(body).toContain("A subtask asks to change the contract");
      expect(body).toContain("Agreed: + deliverySlotId, optional");
      expect(body).toContain("Asks for: + deliverySlotId, required");
      // the subtask's own page sends to the master
      const subBody = runContent(
        await runPage(rt, createEngine(rt), sub as never, { homeDir: sb.home }),
        Date.now(),
      ).value;
      expect(subBody).toContain("This subtask asks to change the contract");
      expect(subBody).toContain(`jarvis subtask contract ${short} 1 --accept | --reject`);
    } finally {
      rt.close();
    }
    const listed = await jarvis(meta, ["subtask", "contract", short]);
    expect(listed.out).toContain("subtask 1 (orders-api) asks to change topic orders.created");
    expect(listed.out).toContain("agreed:   + deliverySlotId, optional");

    const accepted = await jarvis(meta, [
      "subtask",
      "contract",
      short,
      "orders-api",
      "--accept",
      "--change",
      "+ deliverySlotId, required, a string",
    ]);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain("contract changed: split v2");
    // the asking subtask goes on in its repository
    expect(launches.map((l) => [l.args.join(" "), l.cwd])).toEqual([
      [`resume ${subId}`, join(repos, "orders-api")],
    ]);
    rt = await knowledgeRuntime();
    try {
      const split = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(masterId, "split")[0] as never)) as {
        contract: Array<{ change: string }>;
      };
      expect(split.contract[0]?.change).toBe("+ deliverySlotId, required, a string");
      expect(rt.artifacts.listLatest(masterId, "split")[0]?.provenance.kind).toBe("human");
    } finally {
      rt.close();
    }
    // its impact runs again with the new contract — and asks once more: a new request
    const again = await next();
    expect(again.result.out).toContain("WAITING_HUMAN");
    const rejected = await jarvis(meta, [
      "subtask",
      "contract",
      short,
      "1",
      "--reject",
      "--why",
      "keep it optional",
    ]);
    expect(rejected.code).toBe(0);
    const done = await next();
    expect(done.result.code).toBe(0);
    rt = await knowledgeRuntime();
    try {
      const run = rt.runs.get(subId);
      expect(run?.state).toBe("COMPLETED");
      const { notesOf } = await import("../../src/interaction/notes.ts");
      const notes = notesOf(rt, subId).map((n) => n.text);
      expect(notes[0]).toContain(
        "The master accepted the contract change: topic orders.created: + deliverySlotId, required, a string",
      );
      expect(notes[1]).toContain("The master keeps the contract as agreed");
      expect(notes[1]).toContain("keep it optional");
      expect(rt.events.list({ runId: masterId, kind: "contract.changeDecided" }).length).toBe(2);
    } finally {
      rt.close();
    }
  });
});

describe("a contract change whose code is in a library the split has no subtask for", () => {
  const ASKS_LIB = `name: sdd
entry: impact
steps:
  - id: impact
    kind: deterministic
    tool: artifact.write
    args: { type: impact, name: impact.json, content: '{"affected":[],"contractChange":{"item":"OrderDto","kind":"dto","change":"+ deliverySlotId","why":"OrderDto is declared in common-lib","owner":"common-lib"}}' }
    outputs: [impact]
    transitions: { onSuccess: DONE }
`;

  it("accepted: the library gets a subtask and changes first; the asking one goes on once it is published", async () => {
    sb.write("repos/jarvis-knowledge/.jarvis/workflows/sdd.yaml", ASKS_LIB);
    sb.write(
      "repos/jarvis-knowledge/.jarvis/project.yaml",
      [
        "version: 1",
        "workspace: { mode: cwd }",
        "crossRepos: { maxParallel: 2 }",
        "services:",
        "  common-lib:",
        "    kind: library",
        "    publishes: [com.example:common-lib]",
        '    tools: { local: { publish-local: "echo published > published.txt" } }',
        "  orders-api:",
        "    uses: [common-lib]",
        "  notify-api: {}",
        "",
      ].join("\n"),
    );
    repo("common-lib");
    sb.write("repos/common-lib/gradle.properties", "version=2.16.0\n");
    await jarvis(meta, ["work", "ABC-63 delivery slot", "--workflow", "sdd-cross"]);
    const masterId = launches[0]?.args[2] as string;
    const short = masterId.slice(4, 12);
    // orders-api and notify-api start; orders-api asks for a change of common-lib's DTO
    expect(launches.map((l) => l.args[3])).toEqual(["1", "2"]);
    const first = await next();
    expect(first.result.out).toContain("WAITING_HUMAN");
    launches.length = 0;
    let rt = await knowledgeRuntime();
    let subId: string;
    try {
      subId = subtasksOf(rt, rt.runs.get(masterId) as never)[0]?.run?.id as string;
      const body = runContent(
        await runPage(rt, createEngine(rt), rt.runs.get(masterId) as never, { homeDir: sb.home }),
        Date.now(),
      ).value;
      expect(body).toContain("which has no subtask: accepting adds one. It changes first;");
    } finally {
      rt.close();
    }

    const accepted = await jarvis(meta, ["subtask", "contract", short, "1", "--accept"]);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain("the library common-lib got subtask 3, started first");
    // the library starts in its repository; the asking subtask is not resumed yet
    expect(launches.map((l) => [l.args.join(" "), l.cwd])).toEqual([
      [`subtask run ${masterId} 3`, join(repos, "common-lib")],
    ]);
    rt = await knowledgeRuntime();
    try {
      const split = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(masterId, "split")[0] as never)) as {
        subtasks: Array<{ key: string; service: string; deliverAfter?: string[] }>;
        contract: Array<{ id: string; producer: string; consumers: string[] }>;
      };
      expect(split.subtasks.find((s) => s.key === "3")?.service).toBe("common-lib");
      expect(split.subtasks.find((s) => s.key === "1")?.deliverAfter).toEqual(["3"]);
      expect(split.contract.find((c) => c.id === "OrderDto")).toMatchObject({
        producer: "common-lib",
        consumers: ["orders-api"],
      });
      // the asking subtask's page: it waits for the library, nothing to decide
      const subBody = runContent(
        await runPage(rt, createEngine(rt), rt.runs.get(subId) as never, { homeDir: sb.home }),
        Date.now(),
      ).value;
      expect(subBody).toContain("The contract change is the library&#39;s: it changes first");
      expect(subBody).not.toContain("This subtask asks to change the contract");
    } finally {
      rt.close();
    }

    // the library's own run: its impact asks too (the same fixed artifact) — kept as agreed, it completes
    const lib = await next();
    expect(lib.result.out).toContain("WAITING_HUMAN");
    expect((await jarvis(meta, ["subtask", "contract", short, "3", "--reject"])).code).toBe(0);
    expect(launches.map((l) => l.cwd)).toEqual([join(repos, "common-lib")]);
    const libDone = await next();
    expect(libDone.result.code).toBe(0);
    // accepted and published: the asking subtask goes on, against the new version
    expect(readFileSync(join(repos, "common-lib", "published.txt"), "utf8")).toBe("published\n");
    expect(launches.map((l) => [l.args.join(" "), l.cwd])).toEqual([
      [`resume ${subId}`, join(repos, "orders-api")],
    ]);
    const again = await next();
    // its impact again with the new contract (and, fixed, it asks once more — the library has a subtask now)
    expect(again.result.out).toContain("WAITING_HUMAN");
    rt = await knowledgeRuntime();
    try {
      const pending = (await import("../../src/app/contractChange.ts")).pendingContractRequests(
        rt,
        rt.runs.get(masterId) as never,
      );
      expect(pending.map((p) => [p.key, p.adds])).toEqual([["1", undefined]]);
      const { notesOf } = await import("../../src/interaction/notes.ts");
      expect(notesOf(rt, subId)[0]?.text).toContain(
        "It is a change of the library common-lib: its subtask 3 changes it first",
      );
    } finally {
      rt.close();
    }
  });
});

describe("the master's budget", () => {
  it("is the sum of its subtasks'; spent, a subtask's model call is refused with a budget stop", async () => {
    sb.write(
      "repos/jarvis-knowledge/.jarvis/project.yaml",
      "version: 1\nworkspace: { mode: cwd }\ncrossRepos: { maxParallel: 1 }\nbudget: { perRun: { outputTokens: 100 } }\nservices:\n  orders-api: {}\n  notify-api: {}\n",
    );
    await jarvis(meta, ["work", "ABC-62 delivery slot", "--workflow", "sdd-cross"]);
    const masterId = launches[0]?.args[2] as string;
    await next();
    const rt = await knowledgeRuntime();
    try {
      const { checkMasterBudget, masterBudgetOf } = await import("../../src/app/masterBudget.ts");
      const { BudgetedGateway } = await import("../../src/budget/runBudget.ts");
      const master = rt.runs.get(masterId) as never;
      const sub = subtasksOf(rt, master)[0]?.run;
      if (!sub) throw new Error("no subtask run");
      // two subtasks of 100 output tokens each: 200 for the master
      expect(masterBudgetOf(rt, master)).toMatchObject({
        limit: { outputTokens: 200 },
        spent: { outputTokens: 0 },
      });
      const spend = (n: number) =>
        rt.events.emit({
          kind: "model.call",
          runId: sub.id,
          stepId: "impact",
          iteration: 1,
          payload: { modelId: "m", outputTokens: n, promptTokens: 0 },
        });
      spend(150);
      expect(() => checkMasterBudget(rt, sub)).not.toThrow();
      spend(60);
      expect(masterBudgetOf(rt, master)?.exhausted).toEqual({
        dimension: "outputTokens",
        used: 210,
        cap: 200,
      });
      // a subtask's call: refused before it is made, as a stop on the master's budget
      const calls: unknown[] = [];
      const gateway = new BudgetedGateway(
        {
          call: async (r: unknown) => {
            calls.push(r);
            return {} as never;
          },
        } as never,
        rt.db.db,
        { ...rt.loaded.config, budget: { perRun: {}, perStep: {} } },
        { runId: sub.id, stepId: "plan", iteration: 1 },
        () => 1,
        undefined,
        () => checkMasterBudget(rt, sub),
      );
      await expect(gateway.call({ modelId: "m", messages: [] } as never)).rejects.toMatchObject({
        scope: "master",
        dimension: "outputTokens",
        used: 210,
        cap: 200,
      });
      expect(calls).toEqual([]);
      // the page: spent of the sum, and why the subtasks stop
      const body = runContent(
        await runPage(rt, createEngine(rt), master, { homeDir: sb.home }),
        Date.now(),
      ).value;
      expect(body).toContain("Budget, the sum of the subtasks&#39;: 210 of 200 output tokens");
      expect(body).toContain("The master&#39;s budget is spent");
      // more on the subtask's budget stop grows its share, and the sum
      rt.events.emit({
        kind: "budget.grant",
        runId: sub.id,
        stepId: "plan",
        iteration: 1,
        payload: { scope: "master", dimension: "outputTokens", outputTokens: 50 },
      });
      expect(masterBudgetOf(rt, master)).toMatchObject({ limit: { outputTokens: 250 } });
      expect(masterBudgetOf(rt, master)?.exhausted).toBeUndefined();
      await expect(gateway.call({ modelId: "m", messages: [] } as never)).resolves.toBeDefined();
    } finally {
      rt.close();
    }
    const list = await jarvis(meta, ["subtask", "list", masterId.slice(4, 12)]);
    expect(list.out).toContain("budget (sum of the subtasks'): 210 of 250 output tokens");
  });
});
