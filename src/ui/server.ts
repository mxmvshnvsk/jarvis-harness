import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Runtime } from "../app/runtime.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import type { LocalWorkflowEngine } from "../orchestration/runtime.ts";
import { shortRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import { SCRIPT, STYLE } from "./assets.ts";
import { type DiffFile, html, parseDiff } from "./html.ts";
import { artifactPage, runPage, runsPage } from "./model.ts";
import {
  type ArtifactExtras,
  artifactContent,
  type Chrome,
  errorContent,
  forbiddenPage,
  layout,
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
  "Referrer-Policy": "no-referrer",
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
  ) => send(r, status, layout({ ...chrome, address: address() }, content));
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

  const routes = async (r: Request): Promise<void> => {
    const path = r.url.pathname;
    const now = Date.now();
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
        runsContent(model, now),
      );
    }
    const runMatch = /^\/runs\/([^/]+)$/.exec(path);
    if (runMatch) {
      const run = resolveRun(runMatch[1] as string);
      if (!run) return notFound(r, `No run "${runMatch[1]}".`);
      const model = await runPage(runtime, engine, run, { homeDir: options.homeDir });
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
        runContent(model, now),
      );
    }
    const artMatch = /^\/runs\/([^/]+)\/artifacts\/([^/]+)\/([^/]+)$/.exec(path);
    if (artMatch) {
      const run = resolveRun(artMatch[1] as string);
      if (!run) return notFound(r, `No run "${artMatch[1]}".`);
      const v = Number(r.url.searchParams.get("v"));
      const type = decodeURIComponent(artMatch[2] as string);
      const name = decodeURIComponent(artMatch[3] as string);
      const model = artifactPage(runtime, run, type, name, Number.isInteger(v) && v > 0 ? v : undefined);
      if (!model) return notFound(r, `Run ${shortRunId(run.id)} has no ${type}/${name}.`);
      const extras: ArtifactExtras = {};
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
    if (req.method !== "GET") return send(r, 405, "405 — method not allowed", "text/plain; charset=utf-8");
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
        for (const c of clients) c.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
