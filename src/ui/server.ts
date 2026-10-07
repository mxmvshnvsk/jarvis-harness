import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  awaitedArtifact,
  DecisionTakenError,
  recordDecision,
  requestRerun,
  rerunRequested,
} from "../app/decide.ts";
import { modelsHealthOf } from "../app/modelHealth.ts";
import type { Runtime } from "../app/runtime.ts";
import { type OpenIn, reviewFiles } from "../cli/checkout.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import type { LocalWorkflowEngine } from "../orchestration/runtime.ts";
import { shortRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import { SCRIPT, STYLE } from "./assets.ts";
import { type DiffFile, type Html, html, parseDiff } from "./html.ts";
import { type Launcher, WORKFLOWS } from "./launcher.ts";
import { artifactPage, runPage, runsPage } from "./model.ts";
import {
  type Actions,
  type ArtifactExtras,
  artifactContent,
  type Chrome,
  errorContent,
  forbiddenPage,
  layout,
  modelsPopover,
  modelsSummary,
  repoPicker,
  runContent,
  runsContent,
} from "./pages.ts";

/**
 * `jarvis ui` (ADR-0023 §3, §5): a local page over the journal. `node:http`, no framework; only
 * 127.0.0.1; a random session token in the address, required on every request (a cookie after the
 * first one); live updates by Server-Sent Events from the tail of `events`, polled once a second as
 * `jarvis follow` does. The server never runs a workflow and never holds a lease: it reads, and —
 * with actions — records decisions through the same functions as the terminal.
 */
export interface UiServerOptions {
  readonly runtime: Runtime;
  readonly engine: LocalWorkflowEngine;
  /** 0 picks a free port. */
  readonly port?: number;
  readonly token?: string;
  readonly homeDir: string;
  /** The repository `jarvis ui` was started in: its runs are shown first. */
  readonly projectRoot?: string;
  /** The actor of decisions made on the page (the CLI's, ADR-0006). */
  readonly actor?: () => Promise<Actor | undefined>;
  /** How often the journal is looked at for live updates (ms). */
  readonly pollMs?: number;
  /** "Open in editor": the run's checkout in the person's editor (the card's `o`). */
  readonly open?: OpenIn;
  /** Pages only: no forms, no POST. */
  readonly readOnly?: boolean;
  /** Starts runs from the page and drives them (src/ui/launcher.ts); none — no "New task". */
  readonly launcher?: Launcher;
}

export interface UiServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // same-origin: no referrer for the fonts, and a form post keeps its Origin (no-referrer makes it "null")
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store",
};

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** The context of one request: the page's address, how to answer. */
interface Request {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const { runtime, engine } = options;
  const token = options.token ?? randomBytes(24).toString("base64url");
  let port = options.port ?? 0;
  const cookie = () => `jarvis_ui_${port}`;
  const address = () => `127.0.0.1:${port}`;

  /* ---- live updates: one poller over the journal, fanned out to every open page ---- */
  const clients = new Set<ServerResponse>();
  let seq = runtime.events.lastSeq();
  let poller: ReturnType<typeof setInterval> | undefined;
  let beat = 0;
  const poll = () => {
    try {
      const batch = runtime.events.list({ afterSeq: seq, limit: 5000 });
      if (batch.length > 0) {
        seq = batch.at(-1)?.seq ?? seq;
        const runs = [...new Set(batch.map((e) => e.runId).filter((r): r is string => !!r))];
        const data = JSON.stringify({ seq, runs });
        for (const c of clients) c.write(`event: journal\ndata: ${data}\n\n`);
      } else if (++beat % 15 === 0) for (const c of clients) c.write(": still here\n\n");
    } catch {
      // a busy database: the next tick catches up from the same seq
    }
  };
  const watch = () => {
    if (!poller) {
      seq = runtime.events.lastSeq();
      poller = setInterval(poll, options.pollMs ?? 1000);
      poller.unref?.();
    }
  };
  const unwatch = () => {
    if (poller && clients.size === 0) {
      clearInterval(poller);
      poller = undefined;
    }
  };

  // runs the page started: match them to their launches, go on after a wait (src/ui/launcher.ts)
  const tender = options.launcher
    ? setInterval(() => {
        try {
          options.launcher?.tend();
        } catch {
          // a busy database: the next tick tries again
        }
      }, 2000)
    : undefined;
  tender?.unref?.();

  /* ---- answers ---- */
  const send = (r: Request, status: number, body: string, type = "text/html; charset=utf-8", extra = {}) => {
    r.res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, ...extra });
    r.res.end(body);
  };
  const page = (
    r: Request,
    status: number,
    chrome: Omit<Chrome, "address">,
    content: ReturnType<typeof html>,
  ) => {
    const theme = cookieOf(r.req, "jarvis_theme");
    send(
      r,
      status,
      layout(
        {
          ...chrome,
          address: address(),
          ...(theme === "light" || theme === "dark" ? { theme } : {}),
          ...(options.launcher && actions ? { canStart: true } : {}),
        },
        content,
      ),
    );
  };
  const notFound = (r: Request, message: string) =>
    page(
      r,
      404,
      { title: "Not found", page: "error" },
      errorContent(404, message, html`<a href="/">All runs</a>`),
    );

  /** The session token: from the address the first time (then a cookie and a clean address), or the cookie. */
  const authorized = (r: Request): "ok" | "redirect" | "no" => {
    const fromQuery = r.url.searchParams.get("t");
    if (fromQuery && same(fromQuery, token)) return "redirect";
    const fromCookie = cookieOf(r.req, cookie());
    return fromCookie && same(fromCookie, token) ? "ok" : "no";
  };

  /** Requests for another host name (DNS rebinding) are refused before anything else. */
  const hostOk = (req: IncomingMessage) => {
    const host = req.headers.host ?? "";
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  const resolveRun = (ref: string): Run | undefined => runtime.runs.resolve(decodeURIComponent(ref));

  const diffOf = async (run: Run): Promise<{ files?: DiffFile[]; note?: string }> => {
    if (!existsSync(run.workspace.path)) return { note: `The run's checkout is gone: ${run.workspace.path}` };
    const base = run.workspace.baseCommit ?? run.workspace.baseRef;
    const r = await git(["diff", "--no-color", "--no-ext-diff", base], run.workspace.path, {
      maxBytes: 4 * 1024 * 1024,
    });
    if (r.code !== 0) return { note: "No diff: the checkout is not a git repository here." };
    return { files: parseDiff(r.stdout) };
  };

  const actions: Actions | undefined = options.readOnly ? undefined : { token };

  /** What a POST came back with, as a fixed message: nothing from the address is shown as markup. */
  const noticeOf = (r: Request): Html | undefined => {
    const n = r.url.searchParams.get("notice");
    const editor = r.url.searchParams.get("editor") ?? "your editor";
    const notices: Record<string, Html> = {
      opened: html`<div class="banner ok">↗ opened in ${editor} — the page watches the checkout: save there, then run the step again</div>`,
      "no-editor": html`<div class="banner bad">No editor found — set JARVIS_EDITOR (code, idea, webstorm…) where you start <code>jarvis ui</code></div>`,
      "no-checkout": html`<div class="banner bad">The run's checkout is gone</div>`,
      actor: html`<div class="banner bad">Cannot determine who decides: set JARVIS_ACTOR, actor.id or git config user.email (ADR-0006)</div>`,
      taken: html`<div class="banner bad">This version was decided meanwhile (in a terminal or another window): yours is not recorded</div>`,
      stale: html`<div class="banner bad">The run no longer waits for this version: nothing recorded</div>`,
      empty: html`<div class="banner bad">Say what to change — a comment, or comments on lines of the diff</div>`,
      "not-waiting": html`<div class="banner bad">The run no longer waits at this loop: nothing recorded</div>`,
      started: html`<div class="banner ok">Started — it prepares its checkout and shows up under Running; where it needs you, it waits here</div>`,
      "no-task": html`<div class="banner bad">Say what to do and pick a workflow</div>`,
      "no-repo": html`<div class="banner bad">Not a repository this page knows: start <code>jarvis ui</code> in it</div>`,
    };
    return n ? notices[n] : undefined;
  };

  const redirect = (r: Request, location: string) => {
    r.res.writeHead(303, { ...SECURITY_HEADERS, Location: location });
    r.res.end();
  };

  /** A form posted by the page: url-encoded, small. */
  const formOf = (req: IncomingMessage): Promise<URLSearchParams> =>
    new Promise((resolve, reject) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        body += c;
        if (body.length > 512 * 1024) {
          reject(new Error("form too large"));
          req.destroy();
        }
      });
      req.on("end", () => resolve(new URLSearchParams(body)));
      req.on("error", reject);
    });

  /** Line comments from the diff, `path:line — text` one a line (ADR-0019 §5). */
  const linesOf = (raw: string | null): string[] => {
    try {
      const v: unknown = JSON.parse(raw || "[]");
      if (!Array.isArray(v)) return [];
      return v
        .slice(0, 500)
        .filter(
          (c): c is { where: string; text: string } =>
            !!c && typeof c.where === "string" && typeof c.text === "string" && c.text.trim().length > 0,
        )
        .map((c) => `${c.where.slice(0, 300)} — ${c.text.trim().slice(0, 4000)}`);
    } catch {
      return [];
    }
  };

  /** Repositories a task may be started in: the one `jarvis ui` runs in and those with runs. */
  const knownRepos = (): string[] => [
    ...new Set([
      ...(options.projectRoot ? [options.projectRoot] : []),
      ...runtime.runs.list({ includeTerminal: true, limit: 500 }).map((x) => x.workspace.repoRoot),
    ]),
  ];

  /** "New task": the CLI started in the background, driven by the page (src/ui/launcher.ts). */
  const startTask = async (r: Request): Promise<void> => {
    const launcher = options.launcher;
    if (!launcher || !actions) return notFound(r, "Starting tasks is off here.");
    const form = await formOf(r.req);
    const sent = form.get("t");
    if (!sent || !same(sent, token)) return send(r, 403, forbiddenPage());
    const task = (form.get("task") ?? "").trim().slice(0, 4000);
    const workflow = WORKFLOWS.find((w) => w.id === form.get("workflow"))?.id;
    const repo = form.get("repo") ?? options.projectRoot ?? "";
    if (!task || !workflow) return redirect(r, "/?notice=no-task#new");
    if (!knownRepos().includes(repo) || !existsSync(repo)) return redirect(r, "/?notice=no-repo#new");
    launcher.start({ task, workflow, repoRoot: repo });
    return redirect(r, `/?repo=${encodeURIComponent(repo)}&notice=started`);
  };

  /** Accept / Send back / Run again / Open in editor: the same functions as the terminal's keys. */
  const post = async (r: Request): Promise<void> => {
    if (r.url.pathname === "/runs/new") return startTask(r);
    const m = /^\/runs\/([^/]+)\/(decide|rerun|open)$/.exec(r.url.pathname);
    const run = m ? resolveRun(m[1] as string) : undefined;
    if (!m || !run || !actions) return notFound(r, `Nothing to do at ${r.url.pathname}.`);
    const form = await formOf(r.req);
    const sent = form.get("t");
    if (!sent || !same(sent, token)) return send(r, 403, forbiddenPage());
    const short = shortRunId(run.id);
    const actor = async () => (options.actor ? await options.actor() : undefined);
    if (m[2] === "open") {
      if (!existsSync(run.workspace.path)) return redirect(r, `/runs/${short}?notice=no-checkout`);
      // the files the loop's reasons name first, at their lines, then what the run changed (as `o`)
      const record =
        run.waitingFor?.kind === "loop"
          ? runtime.artifacts.listLatest(run.id, "loop-exhausted")[0]
          : undefined;
      let reasons = "";
      try {
        const doc = record ? (JSON.parse(runtime.artifacts.text(record)) as { reason?: unknown }) : undefined;
        reasons = typeof doc?.reason === "string" ? doc.reason : "";
      } catch {
        reasons = "";
      }
      const files = reviewFiles(
        run.workspace.path,
        run.workspace.baseCommit ?? run.workspace.baseRef,
        reasons,
      );
      const editor = options.open?.(run.workspace.path, files);
      return redirect(
        r,
        editor
          ? `/runs/${short}?notice=opened&editor=${encodeURIComponent(editor)}`
          : `/runs/${short}?notice=no-editor`,
      );
    }
    if (m[2] === "rerun") {
      if (run.state !== "WAITING_HUMAN" || run.waitingFor?.kind !== "loop")
        return redirect(r, `/runs/${short}?notice=not-waiting`);
      if (!rerunRequested(runtime, run.id)) {
        const who = await actor();
        if (!who) return redirect(r, `/runs/${short}?notice=actor`);
        requestRerun(runtime, run, who, "ui");
      }
      options.launcher?.resume(run); // a run the page started goes on in the background
      return redirect(r, `/runs/${short}`);
    }
    // decide: only the version the run waits on now, once
    const awaited = run.state === "WAITING_HUMAN" ? awaitedArtifact(runtime, run) : undefined;
    const version = Number(form.get("version"));
    const back = (notice?: string, v = version) =>
      `/runs/${short}/artifacts/${encodeURIComponent(awaited?.type ?? "artifact")}/${encodeURIComponent(awaited?.artifact.name ?? "")}?v=${v}${notice ? `&notice=${notice}` : ""}`;
    if (
      !awaited ||
      awaited.artifact.artifactId !== form.get("artifact") ||
      awaited.artifact.version !== version
    )
      return awaited ? redirect(r, back("stale")) : redirect(r, `/runs/${short}?notice=not-waiting`);
    const decision = form.get("decision");
    if (decision !== "approve" && decision !== "request_changes") return redirect(r, back());
    const lines = linesOf(form.get("lines"));
    const comment = [
      (form.get("comment") ?? "").trim().slice(0, 20_000),
      lines.length > 0 ? `Comments on lines:\n${lines.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (decision === "request_changes" && !comment) return redirect(r, back("empty"));
    const who = await actor();
    if (!who) return redirect(r, back("actor"));
    try {
      recordDecision(runtime, run, {
        actor: who,
        artifact: awaited.artifact,
        type: awaited.type,
        decision,
        ...(comment ? { comment } : {}),
        channel: "ui",
      });
    } catch (error) {
      if (!(error instanceof DecisionTakenError)) throw error;
      return redirect(r, back("taken"));
    }
    options.launcher?.resume(run); // a run the page started goes on in the background
    return redirect(r, back());
  };

  const routes = async (r: Request): Promise<void> => {
    const path = r.url.pathname;
    const now = Date.now();
    if (r.req.method === "POST") return post(r);
    if (path === "/") {
      const repoParam = r.url.searchParams.get("repo");
      const all = runtime.runs.list({ includeTerminal: true, limit: 500 });
      const here = options.projectRoot && all.some((x) => x.workspace.repoRoot === options.projectRoot);
      const repo = repoParam === null ? (here ? options.projectRoot : undefined) : repoParam || undefined;
      const model = await runsPage(runtime, engine, {
        ...(repo ? { repo } : {}),
        ...(options.projectRoot ? { current: options.projectRoot } : {}),
        homeDir: options.homeDir,
      });
      return page(
        r,
        200,
        {
          title: "Runs",
          page: "runs",
          repos: repoPicker(model),
          ...(model.running.length > 0 ? { tick: 5000 } : {}),
        },
        runsContent(
          model,
          now,
          actions,
          options.launcher && actions
            ? {
                workflows: WORKFLOWS,
                repos: knownRepos(),
                ...(noticeOf(r) ? { notice: noticeOf(r) as Html } : {}),
                ...((repo ?? options.projectRoot)
                  ? { current: (repo ?? options.projectRoot) as string }
                  : {}),
                homeDir: options.homeDir,
                launches: options.launcher
                  .list()
                  .filter((l) => !l.runId && (!repo || l.repoRoot === repo))
                  .map((l) => ({
                    id: l.id,
                    task: l.task,
                    workflow: l.workflow,
                    startedAt: l.startedAt,
                    exitCode: l.exitCode,
                    log: l.log,
                    ...(l.exitCode !== null ? { tail: options.launcher?.tail(l) ?? "" } : {}),
                  })),
              }
            : undefined,
        ),
      );
    }
    const runMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (runMatch) {
      const run = resolveRun(runMatch[1] as string);
      if (!run) return notFound(r, `No run "${runMatch[1]}".`);
      const model = {
        ...(await runPage(runtime, engine, run, { homeDir: options.homeDir })),
        driven: options.launcher?.drives(run.id) === true,
      };
      const ticking = run.state === "RUNNING" || model.card?.kind === "loop";
      return page(
        r,
        200,
        {
          title: `run ${shortRunId(run.id)}`,
          page: "run",
          runId: run.id,
          back: { href: "/", label: "Runs" },
          ...(ticking ? { tick: 3000 } : {}),
        },
        runContent(model, now, actions, noticeOf(r)),
      );
    }
    const artMatch = /^\/runs\/([^/]+)\/artifacts\/([^/]+)\/([^/]+)$/.exec(path);
    if (artMatch) {
      const run = resolveRun(artMatch[1] as string);
      if (!run) return notFound(r, `No run "${artMatch[1]}".`);
      const v = Number(r.url.searchParams.get("v"));
      const type = decodeURIComponent(artMatch[2] as string);
      const name = decodeURIComponent(artMatch[3] as string);
      const found = artifactPage(runtime, run, type, name, Number.isInteger(v) && v > 0 ? v : undefined);
      const model = found ? { ...found, driven: options.launcher?.drives(run.id) === true } : found;
      if (!model) return notFound(r, `Run ${shortRunId(run.id)} has no ${type}/${name}.`);
      const notice = noticeOf(r);
      const extras: ArtifactExtras = {
        ...(actions ? { actions, comments: true } : {}),
        ...(notice ? { banner: notice } : {}),
      };
      if (type === "implementation") {
        const d = await diffOf(run);
        Object.assign(extras, d.files ? { diff: d.files } : {}, d.note ? { diffNote: d.note } : {});
      }
      return page(
        r,
        200,
        {
          title: `${type}/${name}@${model.artifact.version}`,
          page: "artifact",
          runId: run.id,
          back: { href: `/runs/${shortRunId(run.id)}`, label: `run ${shortRunId(run.id)}` },
        },
        artifactContent(model, extras),
      );
    }
    if (path === "/models.json") {
      // the header's indicator: polled by the page and on every event of the journal
      const health = modelsHealthOf(runtime);
      return send(
        r,
        200,
        JSON.stringify({
          state: health.state,
          title: modelsSummary(health),
          html: modelsPopover(health).value,
        }),
        "application/json; charset=utf-8",
        { "Cache-Control": "no-store" },
      );
    }
    if (path === "/live") {
      r.res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
      });
      r.res.write("retry: 2000\n\n");
      clients.add(r.res);
      watch();
      r.req.on("close", () => {
        clients.delete(r.res);
        unwatch();
      });
      return;
    }
    return notFound(r, `Nothing at ${path}.`);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
    const r: Request = { req, res, url };
    if (!hostOk(req)) return send(r, 403, "403 — unexpected host", "text/plain; charset=utf-8");
    // style and script carry nothing of the runs: no token needed, so the first page loads them
    if (req.method === "GET" && url.pathname === "/assets/app.css")
      return send(r, 200, STYLE, "text/css; charset=utf-8", { "Cache-Control": "no-cache" });
    if (req.method === "GET" && url.pathname === "/assets/app.js")
      return send(r, 200, SCRIPT, "text/javascript; charset=utf-8", { "Cache-Control": "no-cache" });
    if (url.pathname === "/favicon.ico") return send(r, 204, "", "text/plain");
    const auth = authorized(r);
    if (auth === "no") return send(r, 403, forbiddenPage());
    if (auth === "redirect") {
      // the token leaves the address bar and the history: from now on the cookie carries it
      url.searchParams.delete("t");
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        Location: `${url.pathname}${url.search}`,
        "Set-Cookie": `${cookie()}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end();
      return;
    }
    if (req.method === "POST") {
      // a page of another origin in the same browser cannot post here: its Origin is not ours
      const origin = req.headers.origin;
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`)
        return send(r, 403, "403 — unexpected origin", "text/plain; charset=utf-8");
    } else if (req.method !== "GET")
      return send(r, 405, "405 — method not allowed", "text/plain; charset=utf-8");
    routes(r).catch((error: unknown) => {
      runtime.log.error("ui.error", {
        path: url.pathname,
        message: String((error as Error)?.message ?? error),
      });
      if (res.headersSent) return res.end();
      page(
        r,
        500,
        { title: "Error", page: "error" },
        errorContent(
          500,
          "The page could not be built.",
          "The technical log has the details: jarvis logs --event ui.error",
        ),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${HOST}:${port}/?t=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        if (poller) clearInterval(poller);
        if (tender) clearInterval(tender);
        for (const c of clients) c.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
