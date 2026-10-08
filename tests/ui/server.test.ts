import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { shortRunId } from "../../src/storage/runStore.ts";
import { escapeHtml, markdownToHtml, parseDiff } from "../../src/ui/html.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0023 §3, §5: the local page — token, read-only pages, escaping, live updates. */
let sb: Sandbox;
let rt: Runtime;
let ui: UiServer;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };

beforeEach(async () => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  rt = createRuntime(loaded, { env: {} });
  ui = await startUiServer({
    runtime: rt,
    engine: createEngine(rt),
    port: 0,
    homeDir: sb.home,
    projectRoot: sb.project,
    pollMs: 30,
  });
});
afterEach(async () => {
  await ui.close();
  await rt.close();
  sb.cleanup();
});

/** A GET (or other) with raw control over headers: fetch would not let us set Host. */
function get(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: ui.port,
        path,
        method,
        headers: { host: `127.0.0.1:${ui.port}`, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const authed = () => ({ cookie: `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}` });

function seedWaiting(task: string, spec: string) {
  const run = rt.runs.create({
    task,
    workflow: "sdd",
    owner: DEV,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "internal",
  });
  const a = rt.artifacts.put({
    runId: run.id,
    type: "spec",
    name: "spec.json",
    content: spec,
    mediaType: "application/json",
    provenance: { kind: "agent", agentId: "spec", modelCallRefs: [], toolCallRefs: [] },
    stepId: "spec",
    iteration: 1,
  });
  rt.events.emit({
    kind: "step.start",
    runId: run.id,
    payload: { stepId: "spec", iteration: 1, kind: "agentic" },
  });
  rt.events.emit({
    kind: "step.finish",
    runId: run.id,
    payload: { stepId: "spec", iteration: 1, status: "success" },
  });
  rt.checkpoints.save({
    runId: run.id,
    stepId: "approve-spec",
    iteration: 1,
    kind: "suspend",
    state: { awaitingApproval: { type: "spec" } },
  });
  rt.runs.update(run.id, { currentStep: "approve-spec" });
  rt.runs.transition(run.id, "RUNNING");
  rt.runs.transition(run.id, "WAITING_HUMAN", {
    reason: "approve spec (spec.json@1)",
    waitingFor: { kind: "approval", detail: "spec" },
  });
  return { run: rt.runs.require(run.id), artifact: a };
}

describe("jarvis ui: the session token", () => {
  it("binds 127.0.0.1 and refuses requests without the token", async () => {
    expect(ui.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${ui.port}/\\?t=`));
    const none = await get("/");
    expect(none.status).toBe(403);
    expect(none.body).toContain("needs its session token");
    expect((await get("/?t=wrong")).status).toBe(403);
    expect((await get("/", { cookie: `jarvis_ui_${ui.port}=wrong` })).status).toBe(403);
    expect((await get("/live")).status).toBe(403);
  });

  it("the token in the address sets a cookie and leaves the address", async () => {
    const first = await get(`/?t=${ui.token}`);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/");
    expect(String(first.headers["set-cookie"])).toContain(`jarvis_ui_${ui.port}=`);
    expect(String(first.headers["set-cookie"])).toContain("HttpOnly; SameSite=Strict");
    const page = await get("/", authed());
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["referrer-policy"]).toBe("same-origin");
  });

  it("refuses another host name (DNS rebinding), even with the token", async () => {
    expect((await get("/", { ...authed(), host: "evil.example:80" })).status).toBe(403);
  });
});

describe("jarvis ui: pages", () => {
  it("a dark theme: the system's by default, the person's pick from a cookie, no hard-coded colours", async () => {
    const auto = await get("/", authed());
    expect(auto.body).toContain('<html lang="en">');
    expect(auto.body).toContain('<meta name="color-scheme" content="light dark">');
    expect(auto.body).toContain("data-theme-switch");
    const dark = await get("/", { cookie: `${authed().cookie}; jarvis_theme=dark` });
    expect(dark.body).toContain('<html lang="en" data-theme="dark">');
    expect(dark.body).toContain('<meta name="color-scheme" content="dark">');
    const odd = await get("/", { cookie: `${authed().cookie}; jarvis_theme="><script>` });
    expect(odd.body).toContain('<html lang="en">');
    const css = (await get("/assets/app.css", authed())).body;
    expect(css).toContain("@media (prefers-color-scheme:dark){:root:not([data-theme=light]){");
    expect(css).toContain(":root[data-theme=dark]{");
    // every colour comes from a token, so both themes cover the whole page
    const rules = css.slice(css.indexOf("*{box-sizing"));
    expect(rules.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).toEqual([]);
  });

  it("the models indicator: a dot in the header, its state and popover from /models.json", async () => {
    const page = await get("/", authed());
    expect(page.body).toContain('aria-controls="models-pop"');
    expect(page.body).toContain('<div id="models-pop" class="pop" role="dialog" aria-label="Models" hidden>');
    expect(page.body).toContain('<span class="dot" data-state="pending" aria-hidden="true">');
    expect(page.body).toContain("waiting for data");
    expect((await get("/models.json")).status).toBe(403);
    // answered at once: "pending" until the background round has the numbers
    let res = await get("/models.json", authed());
    for (let i = 0; i < 50 && JSON.parse(res.body).state === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      res = await get("/models.json", authed());
    }
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/json");
    const data = JSON.parse(res.body) as { state: string; title: string; html: string };
    expect(["ok", "busy", "down", "idle"]).toContain(data.state);
    // the page's script opens the popover and asks for the numbers (pilot: a lost block left it shut)
    const js = (await get("/assets/app.js")).body;
    // the whole script parses: one broken block takes every other one with it
    expect(() => new Function(js)).not.toThrow();
    expect(js).toContain("indicator('models', '/models.json')");
    expect(js).toContain("button.addEventListener('click', () => setOpen(pop.hidden))");
    expect(data.title).toMatch(/^Models: /);
    expect(data.html).toContain("jarvis models stats");
  });

  it("system notifications: a bell in the header, the waiting runs from /waiting.json", async () => {
    const page = await get("/", authed());
    expect(page.body).toContain('data-notify aria-pressed="false"');
    expect((await get("/waiting.json")).status).toBe(403);
    expect(JSON.parse((await get("/waiting.json", authed())).body)).toEqual({ waiting: [] });
    const { run } = seedWaiting(
      "Order form: phone number mask\nmore detail",
      JSON.stringify({ title: "Mask" }),
    );
    rt.events.emit({ kind: "run.state", runId: run.id, payload: { state: "WAITING_HUMAN" } });
    const data = JSON.parse((await get("/waiting.json", authed())).body) as {
      waiting: Array<Record<string, unknown>>;
    };
    expect(data.waiting).toHaveLength(1);
    expect(data.waiting[0]).toMatchObject({
      id: run.id.replace(/^run_/, "").slice(0, 8),
      task: "Order form: phone number mask",
      workflow: "sdd",
      what: "approve the spec",
      terminal: false,
    });
    expect(data.waiting[0]?.parked).toBeGreaterThan(0);
    const js = (await get("/assets/app.js")).body;
    expect(js).toContain("new Notification('Jarvis: ' + w.what");
    expect(js).toContain("Notification.requestPermission()");
  });

  it("a finished run keeps an empty card slot, so the live refresh takes the spinner away", async () => {
    const { run } = seedWaiting("Order form: phone number mask", JSON.stringify({ title: "Mask" }));
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.transition(run.id, "COMPLETED", { reason: "workflow done" });
    const page = await get(`/runs/${run.id.replace(/^run_/, "").slice(0, 8)}`, authed());
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div data-live="card" hidden></div>');
    expect(page.body).not.toContain('class="panel now"');
  });

  it("a working step: its clocks count on in the page between refreshes, the spinner keeps its turn", async () => {
    const run = rt.runs.create({
      task: "Order form: phone number mask",
      workflow: "research",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.acquireLease(run.id, "cli:t", 60_000);
    rt.events.emit({
      kind: "step.start",
      runId: run.id,
      payload: { stepId: "research", iteration: 1, kind: "agentic" },
    });
    rt.events.emit({ kind: "agent.start", runId: run.id, payload: { agent: "research", maxToolCalls: 500 } });
    // the answer of model call 1 asked for two reads: they ran side by side, one still runs
    const at = { runId: run.id, stepId: "research", iteration: 1 };
    rt.events.emit({
      kind: "tool.batch",
      ...at,
      payload: {
        modelCall: 1,
        size: 2,
        parallel: true,
        calls: [
          { capability: "repo.read", args: '{"path":"src/orders/card.tsx"}' },
          { capability: "repo.search", args: '{"pattern":"deliveryDate"}' },
        ],
      },
    });
    rt.events.emit({
      kind: "tool.call",
      ...at,
      payload: {
        capability: "repo.read",
        ok: true,
        durationMs: 40,
        batch: 1,
        slot: 0,
        args: '{"path":"src/orders/card.tsx"}',
      },
    });
    const short = run.id.replace(/^run_/, "").slice(0, 8);
    const page = await get(`/runs/${short}`, authed());
    expect(page.body).toContain("<b>⇉ 2 in parallel</b>");
    expect(page.body).toMatch(
      /class="lane"><span class="ok">✓<\/span><span class="k" title="repo.read">read<\/span><span class="p">src\/orders\/card.tsx<\/span>/,
    );
    expect(page.body).toMatch(
      /class="lane"><span class="spin" aria-label="running"><\/span><span class="k" title="repo.search">search<\/span>/,
    );
    // while its tools run, the model is not asked yet
    expect(page.body).toContain("model call 1 asked for 2 tools · running them");
    expect(page.body).toContain("model call 1 · ⇉ 2 tools in parallel · running");
    expect(page.body).toContain('<span class="sub">read src/orders/card.tsx · 40ms</span>');
    // the batch done: the next model call is waited for, its clock and the step's count on in the page
    rt.events.emit({
      kind: "tool.call",
      ...at,
      payload: {
        capability: "repo.search",
        ok: true,
        durationMs: 90,
        batch: 1,
        slot: 1,
        args: '{"pattern":"deliveryDate"}',
      },
    });
    const after = await get(`/runs/${short}`, authed());
    expect(after.body).toContain("the last batch, model call 1");
    expect(after.body.match(/<span data-ms="\d+">\d+:\d\d<\/span>/g)?.length).toBeGreaterThanOrEqual(3);
    expect(after.body).toMatch(/model call 1, waiting <span data-ms=/);
    const js = (await get("/assets/app.js")).body;
    expect(js).toContain("setInterval(countOn, 1000)");
    // a region with something changed and not sent (ticked boxes of a module's review) is not re-rendered
    expect(js).toContain("return f.checked !== f.defaultChecked;");
    expect(js).toContain("if (edited(el)) continue;");
    expect(js).toContain("inPhase(fresh)");
  });

  it("activity: the newest 5 lines open, everything earlier folded above them, kept open across refreshes", async () => {
    const run = rt.runs.create({
      task: "Order form: phone number mask",
      workflow: "research",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    for (const step of ["discover", "sources", "research", "requirements", "spec", "plan", "review"])
      rt.events.emit({
        kind: "step.finish",
        runId: run.id,
        payload: { stepId: step, iteration: 1, status: "success" },
      });
    const page = await get(`/runs/${run.id.replace(/^run_/, "").slice(0, 8)}`, authed());
    const feed = page.body.slice(page.body.indexOf('data-live="feed"'));
    expect(feed).toContain('<details class="earlier" data-keep="feed-earlier"><summary>2 earlier</summary>');
    expect(feed.indexOf("discover done")).toBeLessThan(feed.indexOf("</details>"));
    expect(feed.indexOf("requirements done")).toBeGreaterThan(feed.indexOf("</details>"));
    expect((await get("/assets/app.js")).body).toContain("details[data-keep]");
  });

  it("recent: every finished run, a page at a time, and a search over all their fields", async () => {
    const make = (task: string, workflow: string, end: "COMPLETED" | "FAILED") => {
      const run = rt.runs.create({
        task,
        workflow,
        owner: DEV,
        workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
        dataClass: "internal",
      });
      rt.runs.transition(run.id, "RUNNING");
      rt.runs.transition(run.id, end, end === "FAILED" ? { reason: "model timed out" } : {});
      return run;
    };
    for (let i = 0; i < 28; i++) make(`ABC-${100 + i}: billing rounding ${i}`, "fix", "COMPLETED");
    const slots = make("ABC-7: delivery slots on the order form", "research", "FAILED");
    make("CONF-12: order card shows the delivery date", "sdd", "COMPLETED");
    const rows = (body: string) => body.match(/<tr><td class="mono">/g)?.length ?? 0;

    const first = await get("/?repo=", authed());
    expect(rows(first.body)).toBe(10); // 10 by default
    expect(first.body).toContain("1–10 of 30");
    expect(first.body).toContain('href="/?repo=&amp;page=2#recent" rel="next"');
    expect(first.body).toContain('<a href="/?repo=#recent" data-size="10" aria-current="true">10</a>');
    expect(first.body).toContain('<a href="/?repo=&amp;size=20#recent" data-size="20">20</a>');
    const third = await get("/?repo=&page=3", authed());
    expect(rows(third.body)).toBe(10);
    expect(third.body).toContain("21–30 of 30");
    const bigger = await get("/?repo=&size=20&page=2", authed());
    expect(rows(bigger.body)).toBe(10);
    expect(bigger.body).toContain("21–30 of 30");
    // what this browser picked last, when the address does not say; a size not offered is the default
    expect(
      rows((await get("/?repo=", { ...authed(), cookie: `${authed().cookie}; jarvis_recent_size=30` })).body),
    ).toBe(30);
    expect(rows((await get("/?repo=&size=7", authed())).body)).toBe(10);

    // every word in some field: the task's words, the workflow, the state and its reason
    const found = await get(`/?repo=&q=${encodeURIComponent("delivery research failed")}`, authed());
    expect(rows(found.body)).toBe(1);
    expect(found.body).toContain("<mark>delivery</mark> slots");
    expect(found.body).toContain("<mark>research</mark>");
    const phrase = await get(`/?repo=&q=${encodeURIComponent('"delivery date"')}`, authed());
    expect(rows(phrase.body)).toBe(1);
    expect(phrase.body).toContain("<mark>delivery date</mark>");
    const byId = await get(`/?repo=&q=${shortRunId(slots.id).slice(0, 6)}`, authed());
    expect(rows(byId.body)).toBe(1);
    expect((await get("/?repo=&q=timed%20out", authed())).body).toContain("ABC-7");
    const none = await get("/?repo=&q=nothing-like-this", authed());
    expect(none.body).toContain("No runs match «nothing-like-this».");
    // the search field keeps what was asked; the page searches as one types
    expect(found.body).toContain('value="delivery research failed"');
    expect((await get("/assets/app.js")).body).toContain("document.querySelector('[data-search]')");
  });

  it("runs: what waits for you first, with what it waits for and a link", async () => {
    const { run } = seedWaiting(
      "Billing: rounding in invoice totals",
      JSON.stringify({
        title: "Round invoice totals once",
        summary: "Totals are rounded per line, not once per invoice.",
        requirements: [{ id: "R1", text: "Round once" }],
        risks: ["Old invoices keep their totals."],
        openQuestions: ["Credit notes too?"],
      }),
    );
    const page = await get("/", authed());
    expect(page.status).toBe(200);
    expect(page.body).toContain("Waits for you");
    expect(page.body).toContain("Billing: rounding in invoice totals");
    expect(page.body).toContain("⏸ approval · spec");
    expect(page.body).toContain("1 requirement · 1 risk · 1 open question");
    const short = run.id.slice(4, 12);
    expect(page.body).toContain(`href="/runs/${short}/artifacts/spec/spec.json?v=1"`);

    const runPage = await get(`/runs/${short}`, authed());
    expect(runPage.status).toBe(200);
    expect(runPage.body).toContain("WAITING_HUMAN · approval");
    expect(runPage.body).toContain("Round invoice totals once");
    expect(runPage.body).toContain(`jarvis continue ${short}`);
    expect(runPage.body).toContain("spec/spec.json@1");

    const doc = await get(`/runs/${short}/artifacts/spec/spec.json`, authed());
    expect(doc.status).toBe(200);
    expect(doc.body).toContain("awaiting your approval");
    expect(doc.body).toContain("<h2>Requirements</h2>");
    expect(doc.body).toContain("Credit notes too?");

    expect((await get("/runs/nope", authed())).status).toBe(404);
    expect((await get(`/runs/${short}/artifacts/spec/other.json`, authed())).status).toBe(404);
  });

  it("escapes what agents wrote: a script in a title or a document is text", async () => {
    const evil = '<script>alert("x")</script>';
    const { run } = seedWaiting(
      `Order form: phone number mask ${evil}`,
      JSON.stringify({
        title: `Mask ${evil}`,
        summary: `<img src=x onerror=alert(1)> and [a link](javascript:alert(1))`,
        risks: [`"><svg onload=alert(1)>`],
      }),
    );
    const short = run.id.slice(4, 12);
    for (const path of ["/", `/runs/${short}`, `/runs/${short}/artifacts/spec/spec.json`]) {
      const page = await get(path, authed());
      expect(page.status).toBe(200);
      expect(page.body).not.toContain("<script>alert");
      expect(page.body).not.toContain("<img src=x");
      expect(page.body).not.toContain("<svg onload");
      expect(page.body).not.toContain('href="javascript:');
    }
    const doc = await get(`/runs/${short}/artifacts/spec/spec.json`, authed());
    expect(doc.body).toContain("Mask &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("live updates: a new event in the journal reaches the open page", async () => {
    const { run } = seedWaiting("Order form: phone number mask", "{}");
    const got = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: ui.port,
          path: `/live?run=${run.id}`,
          headers: { host: `127.0.0.1:${ui.port}`, ...authed() },
        },
        (res) => {
          expect(res.headers["content-type"]).toContain("text/event-stream");
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            data += c;
            if (data.includes("event: journal")) {
              req.destroy();
              resolve(data);
            }
          });
          // the stream is open: something happens in the run
          setTimeout(
            () => rt.events.emit({ kind: "card.open", runId: run.id, payload: { kind: "approval" } }),
            50,
          );
        },
      );
      req.on("error", (e) => (String(e).includes("socket hang up") ? undefined : reject(e)));
      req.end();
      setTimeout(() => reject(new Error("no event")), 3000);
    });
    expect(got).toContain(`"runs":["${run.id}"]`);
  });
});

describe("jarvis ui: rendering", () => {
  it("markdown: headings, lists, code; raw HTML stays text", () => {
    const out = markdownToHtml(
      "# Title\n\nSome **bold** and `code <b>`.\n\n- one\n  - nested\n- two\n\n```\n<script>x</script>\n```\n\n<div>raw</div>",
    ).value;
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>code &lt;b&gt;</code>");
    expect(out.replace(/\n/g, "")).toContain("<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>");
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(out).toContain("&lt;div&gt;raw&lt;/div&gt;");
    expect(escapeHtml(`"'&<>`)).toBe("&quot;&#39;&amp;&lt;&gt;");
  });

  it("diff: files with numbered lines on both sides", () => {
    const files = parseDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,3 +10,3 @@ export function a() {",
        " keep",
        "-old",
        "+new",
        " end",
        "diff --git a/b.txt b/b.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/b.txt",
        "@@ -0,0 +1 @@",
        "+hello",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["src/a.ts", "modified", 1, 1],
      ["b.txt", "added", 1, 0],
    ]);
    expect(files[0]?.lines.slice(1)).toEqual([
      { kind: "context", text: "keep", oldLine: 10, newLine: 10 },
      { kind: "del", text: "old", oldLine: 11 },
      { kind: "add", text: "new", newLine: 11 },
      { kind: "context", text: "end", oldLine: 12, newLine: 12 },
    ]);
  });
});

describe("the page's styles", () => {
  it("scope the open-questions form: a bare .q rule broke Ask's header (pilot)", async () => {
    const { STYLE } = await import("../../src/ui/assets.ts");
    expect(STYLE).not.toMatch(/(^|\n)\.q[ {.:]/);
  });
});
