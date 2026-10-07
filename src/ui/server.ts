import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { budgetGranted, budgetStopOf, grantBudget } from "../app/budgetStop.ts";
import {
  CandidateTargetTaken,
  candidatesOf,
  contentOf,
  existingAt,
  promoteCandidate,
  rejectCandidate,
  targetOf,
} from "../app/candidates.ts";
import {
  awaitedArtifact,
  DecisionTakenError,
  parkedAt,
  recordDecision,
  requestRerun,
  rerunRequested,
  waitingCard,
} from "../app/decide.ts";
import {
  addGlossaryTerm,
  checkSymbols,
  docsOf,
  GLOSSARY,
  GlossaryTermTaken,
  type GlossaryView,
  glossaryOf,
  skillsOf,
  standardsOf,
  usageOf,
} from "../app/knowledgeView.ts";
import { type McpProbe, mcpHealthOf } from "../app/mcpHealth.ts";
import { modelsHealthOf } from "../app/modelHealth.ts";
import type { Runtime } from "../app/runtime.ts";
import { type OpenIn, reviewFiles } from "../cli/checkout.ts";
import type { Actor } from "../core/domain/actor.ts";
import { isTerminal, type Run } from "../core/domain/run.ts";
import { loadKnowledgeDocs } from "../knowledge/resolver.ts";
import { loadGlossary } from "../knowledge/retrieval/glossary.ts";
import type { RetrievalResult } from "../knowledge/retrieval/retriever.ts";
import { refreshIndex, search } from "../knowledge/retrieval/service.ts";
import { loadSkills } from "../knowledge/skills.ts";
import { knowledgeRootsOf } from "../knowledge/sources.ts";
import { loadStandards } from "../knowledge/standards.ts";
import { NOTE_MAX } from "../onboarding/deep.ts";
import { findNode, type ModuleTree, moduleTree } from "../onboarding/tree.ts";
import type { LocalWorkflowEngine } from "../orchestration/runtime.ts";
import { egressNotices } from "../security/policy/egress.ts";
import { shortRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import { SCRIPT, STYLE } from "./assets.ts";
import { type DiffFile, type Html, html, parseDiff } from "./html.ts";
import {
  ARCHITECTURE,
  docsContent,
  glossaryContent,
  type KnowledgeCounts,
  knowledgeTabs,
  overviewContent,
  skillsContent,
  standardsContent,
} from "./knowledge.ts";
import { type Launcher, WORKFLOWS } from "./launcher.ts";
import { artifactPage, runPage, runsPage } from "./model.ts";
import {
  type Draft,
  draftsHtml,
  type ModulesPage,
  modulesContent,
  researchFirst,
  researchOf,
} from "./modules.ts";
import {
  type Actions,
  type ArtifactExtras,
  artifactContent,
  type Chrome,
  errorContent,
  forbiddenPage,
  launchContent,
  layout,
  mcpPending,
  mcpPopover,
  mcpSummary,
  modelsPending,
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
  /** How often each MCP server is checked for an answer (ms); 0 — only on "Check now". */
  readonly mcpCheckEveryMs?: number;
}

export interface UiServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";

/** What a waiting run needs from a person, for a system notification's title. */
export function waitingWhat(run: Run): string {
  const step = run.currentStep ?? "a step";
  const w = run.waitingFor;
  switch (w?.kind) {
    case "approval":
      return `approve the ${w.detail ?? "document"}`;
    case "clarification":
      return "answer the agent's questions";
    case "loop":
      return `${step} sent the work back too often`;
    case "budget":
      return `${step} stopped on a budget`;
    case "effect":
      return "check an external effect";
    case "review":
      return "review the change";
    case "conflict":
      return "resolve a conflict";
    default:
      return "a decision";
  }
}

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
        if (batch.some((e) => e.kind.startsWith("model."))) scheduleHealth(1000);
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

  /*
   * The models indicator: computed in the background every 10 s and soon after model events, kept as
   * the JSON the page asks for — a request never waits for the journal (pilot: the popover stayed
   * shut while the numbers were being collected).
   */
  const PENDING_MODELS = JSON.stringify({
    state: "pending",
    title: "Models: collecting the stats…",
    html: modelsPending().value,
  });
  let modelsJson: string | undefined;
  let healthSoon: ReturnType<typeof setTimeout> | undefined;
  const computeHealth = () => {
    healthSoon = undefined;
    try {
      const health = modelsHealthOf(runtime);
      modelsJson = JSON.stringify({
        state: health.state,
        title: modelsSummary(health),
        html: modelsPopover(health).value,
      });
    } catch {
      // a busy database: the next round tries again
    }
  };
  const scheduleHealth = (ms: number) => {
    if (healthSoon) return;
    healthSoon = setTimeout(computeHealth, ms);
    healthSoon.unref?.();
  };
  const healthTimer = setInterval(() => scheduleHealth(0), 10_000);
  healthTimer.unref?.();
  scheduleHealth(0);

  /*
   * The MCP indicator: the servers as `jarvis mcp list` sees them, the agents' calls of the last half
   * hour, and whether each server answers — a connection of its own at start, every 10 minutes and on
   * "Check now" (a server started by uvx or npx takes seconds to come up: never in a request).
   */
  const PENDING_MCP = JSON.stringify({
    state: "pending",
    title: "MCP: checking the servers…",
    html: mcpPending().value,
  });
  const probes = new Map<string, McpProbe>();
  const checking = new Set<string>();
  let mcpJson: string | undefined;
  const computeMcp = () => {
    try {
      const health = mcpHealthOf(runtime, probes, checking);
      const first = health.servers.some((s) => s.checking && !s.probe);
      mcpJson = JSON.stringify({
        state: first ? "pending" : health.state,
        checking: health.servers.some((s) => s.checking),
        title: first ? "MCP: checking the servers…" : mcpSummary(health),
        html: mcpPopover(health, options.readOnly ? {} : { checkToken: token }).value,
      });
    } catch {
      // a busy database: the next round tries again
    }
  };
  const checkMcp = async () => {
    const ids = runtime.mcp.pool.serverIds().filter((id) => !checking.has(id));
    for (const id of ids) checking.add(id);
    computeMcp();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const { entry, ms } = await runtime.mcp.pool.probe(id);
          probes.set(id, { at: new Date().toISOString(), ok: true, ms, tools: entry.tools.length });
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "error";
          probes.set(id, { at: new Date().toISOString(), ok: false, error: message.slice(0, 300) });
        } finally {
          checking.delete(id);
        }
      }),
    );
    computeMcp();
  };
  const mcpEvery = options.mcpCheckEveryMs ?? 10 * 60_000;
  const mcpChecker = mcpEvery > 0 ? setInterval(() => void checkMcp(), mcpEvery) : undefined;
  mcpChecker?.unref?.();
  const mcpTimer = setInterval(computeMcp, 10_000);
  mcpTimer.unref?.();
  computeMcp();
  if (mcpEvery > 0) void checkMcp();

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
  // ADR-0016 §6: servers out of the data class's network by an exception, said on every page
  const egress = egressNotices(runtime.loaded.config);
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
          ...(egress.length > 0 ? { egress } : {}),
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
      "not-waiting": html`<div class="banner bad">The run no longer waits here: nothing recorded</div>`,
      amount: html`<div class="banner bad">Say how many more — a whole number above zero</div>`,
      resumed: html`<div class="banner ok">Resumed — it goes on in the background; if the window is still full, it waits again</div>`,
      cancelled: html`<div class="banner ok">Cancelled — nothing runs it any more; its checkout and artifacts stay</div>`,
      "cancel-requested": html`<div class="banner ok">Cancel requested — the process running it stops at its next safe point (after the current model or tool call)</div>`,
      "already-ended": html`<div class="banner bad">The run has ended already: nothing to cancel</div>`,
      resuming: html`<div class="banner ok">It is being resumed already</div>`,
      "no-launcher": html`<div class="banner bad">This page cannot start runs: resume it with <code>jarvis resume</code></div>`,
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

  /* ---- Knowledge → Modules: research a module, review its candidate, commit the drafts ---- */
  const root = options.projectRoot;
  const roots = () => knowledgeRootsOf(runtime.loaded, root);
  let treeCache: { key: string; tree: Promise<ModuleTree> } | undefined;
  /** The tree for HEAD and the knowledge as it is now (an accepted draft changes the coverage). */
  const treeOf = async (): Promise<ModuleTree> => {
    const dir = root as string;
    const head = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
    const knowledge = await git(["status", "--porcelain", "--", ".jarvis/knowledge"], dir);
    const key = `${head}|${knowledge.stdout}`;
    if (treeCache?.key !== key) {
      const tree = moduleTree(roots());
      treeCache = { key, tree };
      tree.catch(() => {
        if (treeCache?.tree === tree) treeCache = undefined;
      });
    }
    return treeCache.tree;
  };
  const draftsOf = async (): Promise<Draft[]> => {
    const r = await git(
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".jarvis/knowledge",
        ".jarvis/standards",
        ".jarvis/skills",
      ],
      root as string,
    );
    if (r.code !== 0) return [];
    return r.stdout
      .split("\n")
      .filter((l) => l.length > 3)
      .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3).replace(/^"|"$/g, "") }));
  };
  /** What replacing a person's document with the candidate changes, as a diff. */
  const conflictOf = async (page: Pick<ModulesPage, "selected" | "research">) => {
    const r = page.selected ? page.research.get(page.selected.path) : undefined;
    if (!root || r?.kind !== "candidate") return undefined;
    const file = targetOf(root, r.candidate, undefined);
    const before = existingAt(file);
    if (!before || before.generated) return undefined;
    const dir = mkdtempSync(joinPath(tmpdir(), "jarvis-candidate-"));
    try {
      const next = joinPath(dir, "candidate.md");
      const id = file.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
      writeFileSync(next, contentOf(r.candidate, id));
      const d = await git(["diff", "--no-index", "--no-color", "--no-ext-diff", "--", file, next], dir, {
        maxBytes: 2 * 1024 * 1024,
      });
      const rel = file.slice(root.length + 1);
      return { file: rel, diff: parseDiff(d.stdout).map((f) => ({ ...f, path: rel })) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const knowledgeNotice = (r: Request): Html | undefined => {
    const n = r.url.searchParams.get("notice");
    const count = r.url.searchParams.get("count") ?? "";
    const file = r.url.searchParams.get("file") ?? "";
    const notices: Record<string, Html> = {
      started: html`<div class="banner ok">Research started — it shows up under Runs too; the bell tells you when its candidate is ready</div>`,
      queued: html`<div class="banner ok">${count || "1"} research${count && count !== "1" ? "es" : ""} queued — they run one after another</div>`,
      unqueued: html`<div class="banner ok">Taken out of the queue</div>`,
      resumed: html`<div class="banner ok">Resumed — it goes on in the background; if the window is still full, it waits again</div>`,
      "term-added": html`<div class="banner ok">Added to the glossary as a draft — the next run's searches widen with it</div>`,
      "no-file": html`<div class="banner bad">Not a knowledge file of this repository</div>`,
      "no-path": html`<div class="banner bad">Not a folder of a module here — pick one in the tree or from the path's suggestions</div>`,
      "no-parts": html`<div class="banner bad">Pick at least one part</div>`,
      "check-all": html`<div class="banner bad">Tick every statement under «Check these first» — or send it back with a note</div>`,
      taken: html`<div class="banner bad">The target was written by a person: replace it, or write under another name</div>`,
      accepted: html`<div class="banner ok">Written to <code>${file}</code> — not committed yet</div>`,
      rejected: html`<div class="banner ok">Discarded — nothing written</div>`,
      again: html`<div class="banner ok">Discarded, and researching again with your note</div>`,
      decided: html`<div class="banner bad">This candidate was decided meanwhile (in a terminal or another window)</div>`,
      committed: html`<div class="banner ok">Committed: ${file}</div>`,
      "nothing-to-commit": html`<div class="banner bad">Nothing to commit under .jarvis/</div>`,
      "commit-failed": html`<div class="banner bad">git commit failed — see <code>jarvis logs --event ui.commit</code></div>`,
      opened: html`<div class="banner ok">↗ opened in ${r.url.searchParams.get("editor") ?? "your editor"}</div>`,
      "no-editor": html`<div class="banner bad">No editor found — set JARVIS_EDITOR (code, idea, webstorm…) where you start <code>jarvis ui</code></div>`,
      actor: html`<div class="banner bad">Cannot determine who decides: set JARVIS_ACTOR, actor.id or git config user.email (ADR-0006)</div>`,
    };
    return n ? notices[n] : undefined;
  };
  const modulesPageOf = async (r: Request): Promise<void> => {
    if (!root || !existsSync(root))
      return notFound(r, "Knowledge needs a repository: start jarvis ui in one.");
    const tree = await treeOf();
    const path = (r.url.searchParams.get("path") ?? "").trim().replace(/\/+$/, "") || undefined;
    const selected = path ? findNode(tree, path) : undefined;
    const research = researchOf(runtime, options.launcher?.list() ?? [], root);
    const base = {
      tree,
      ...(path ? { path } : {}),
      ...(selected ? { selected } : {}),
      need: r.url.searchParams.get("need") === "1",
      research,
      drafts: await draftsOf(),
      canStart: !!options.launcher && !!actions,
      root,
      counts: countsOf(),
    };
    const conflict = await conflictOf(base);
    const running = [...research.values()].some((x) =>
      ["starting", "running", "paused", "queued"].includes(x.kind),
    );
    return page(
      r,
      200,
      {
        title: path ? `Modules · ${path}` : "Modules",
        page: "knowledge",
        ...(running ? { tick: 5000 } : {}),
      },
      modulesContent({ ...base, ...(conflict ? { conflict } : {}) }, actions, knowledgeNotice(r)),
    );
  };
  const back = (path: string, notice: string, extra = "") =>
    `/knowledge/modules?${path ? `path=${encodeURIComponent(path)}&` : ""}notice=${notice}${extra}`;
  /** POST /knowledge/…: research, the queue, a candidate's decision, the commit, open in editor. */
  const knowledgePost = async (r: Request): Promise<void> => {
    if (!root || !actions) return notFound(r, `Nothing to do at ${r.url.pathname}.`);
    const form = await formOf(r.req);
    const sent = form.get("t");
    if (!sent || !same(sent, token)) return send(r, 403, forbiddenPage());
    const pathOf = () => (form.get("path") ?? "").trim().replace(/\/+$/, "");
    const at = r.url.pathname;
    // where a commit or an "open" goes back to: a Knowledge page of this server, nothing else
    const backTo = (notice: string, extra = "") => {
      const b = form.get("back") ?? "";
      if (!/^\/knowledge(\/[a-z]+)?(\?[^#]*)?$/.test(b)) return back(pathOf(), notice, extra);
      const u = new URL(b, "http://x");
      u.searchParams.set("notice", notice);
      for (const [k, v] of new URLSearchParams(extra.replace(/^&/, ""))) u.searchParams.set(k, v);
      return `${u.pathname}${u.search}`;
    };
    if (at === "/knowledge/glossary") return glossaryPost(r, form);
    if (at === "/knowledge/modules/research") {
      if (!options.launcher) return notFound(r, "Starting research is off here.");
      const tree = await treeOf();
      const paths = [...new Set(form.getAll("path").map((p) => p.trim().replace(/\/+$/, "")))].filter(
        Boolean,
      );
      if (paths.length === 0) return redirect(r, back(pathOf(), "no-parts"));
      if (paths.some((p) => !findNode(tree, p))) return redirect(r, back(paths[0] as string, "no-path"));
      const note = (form.get("note") ?? "").trim().slice(0, NOTE_MAX);
      const launches = paths.map((module) =>
        options.launcher?.startModule({ module, repoRoot: root, ...(note ? { note } : {}) }),
      );
      const waiting = launches.filter((l) => l?.queued).length;
      return redirect(
        r,
        back(paths[0] as string, waiting > 0 ? "queued" : "started", waiting > 0 ? `&count=${waiting}` : ""),
      );
    }
    if (at === "/knowledge/modules/unqueue") {
      options.launcher?.unqueue(form.get("launch") ?? "");
      return redirect(r, back(pathOf(), "unqueued"));
    }
    if (at === "/knowledge/commit") {
      const drafts = await draftsOf();
      if (drafts.length === 0) return redirect(r, backTo("nothing-to-commit"));
      const files = drafts.map((d) => d.path);
      const names = files.map((f) => f.replace(/^.*\//, "").replace(/\.md$/, "")).slice(0, 4);
      const message = `knowledge: ${names.join(", ")}${files.length > names.length ? ` and ${files.length - names.length} more` : ""}`;
      const add = await git(["add", "-A", "--", ...files], root);
      // the author is the repository's git config, as for any commit made by hand
      const commit = add.code === 0 ? await git(["commit", "-q", "-m", message, "--", ...files], root) : add;
      if (commit.code !== 0) {
        runtime.log.error("ui.commit", { message: commit.stderr.slice(0, 2000) });
        return redirect(r, backTo("commit-failed"));
      }
      return redirect(r, backTo("committed", `&file=${encodeURIComponent(files.join(", "))}`));
    }
    if (at === "/knowledge/open") {
      const file = (form.get("file") ?? "").replace(/^\/+/, "");
      // a knowledge file: under .jarvis/, or a document or skill of knowledge.sources
      const known =
        !file.includes("..") &&
        (file.startsWith(".jarvis/") ||
          (await docsOf(roots())).some((d) => d.path === file) ||
          skillsOf(roots()).some((x) => x.path === file));
      if (!known || !existsSync(joinPath(root, file))) return redirect(r, backTo("no-file"));
      const editor = options.open?.(root, [{ path: file }]);
      return redirect(
        r,
        editor ? backTo("opened", `&editor=${encodeURIComponent(editor)}`) : backTo("no-editor"),
      );
    }
    const m = /^\/knowledge\/candidates\/([^/]+)\/(accept|reject)$/.exec(at);
    if (!m) return notFound(r, `Nothing to do at ${at}.`);
    const id = decodeURIComponent(m[1] as string);
    const all = candidatesOf(runtime, (run) => run.workflow === "onboard-module");
    const c = all.find((x) => x.artifact.artifactId === id);
    if (!c) return notFound(r, "No such candidate.");
    const module = c.doc.module ?? "";
    if (c.decision) return redirect(r, back(module, "decided"));
    const who = options.actor ? await options.actor() : undefined;
    if (!who) return redirect(r, back(module, "actor"));
    if (m[2] === "accept") {
      const checked = new Set(form.getAll("checked").map(Number));
      if (c.review.some((_, i) => !checked.has(i))) return redirect(r, back(module, "check-all"));
      const fileId = (form.get("id") ?? "").trim();
      try {
        const done = promoteCandidate(runtime, {
          root,
          candidate: c,
          actor: who,
          ...(/^[a-z0-9][a-z0-9._-]{0,59}$/.test(fileId) ? { id: fileId } : {}),
          replace: form.get("replace") === "1",
          channel: "ui",
          checked: checked.size,
        });
        return redirect(r, back(module, "accepted", `&file=${encodeURIComponent(done.path)}`));
      } catch (error) {
        if (!(error instanceof CandidateTargetTaken)) throw error;
        return redirect(r, back(module, "taken"));
      }
    }
    const comment = (form.get("comment") ?? "").trim().slice(0, NOTE_MAX);
    rejectCandidate(runtime, c, who, comment || undefined);
    if (form.get("again") === "1" && options.launcher && module) {
      const dropped = (c.doc.dropped ?? []).slice(0, 12).map((d) => `- ${d.section} "${d.what}": ${d.why}`);
      const note = [
        comment,
        dropped.length > 0
          ? `The previous research had these claims dropped by the check against the code:\n${dropped.join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, NOTE_MAX);
      options.launcher.startModule({ module, repoRoot: root, ...(note ? { note } : {}) });
      return redirect(r, back(module, "again"));
    }
    return redirect(r, back(module, "rejected"));
  };

  /* ---- Knowledge: overview, documents, standards, skills, glossary (read-only, a glossary term added) ---- */
  const countsOf = (): KnowledgeCounts => {
    const r = roots();
    const safe = (f: () => number) => {
      try {
        return f();
      } catch {
        return 0;
      }
    };
    return {
      docs: safe(() => loadKnowledgeDocs(r).length),
      standards: safe(() => loadStandards(r).length),
      skills: safe(() => loadSkills(r).length),
      terms: safe(() => loadGlossary(root).length),
    };
  };
  let glossaryCache: { key: string; view: Promise<GlossaryView> } | undefined;
  const glossaryView = async (): Promise<GlossaryView> => {
    const dir = root as string;
    const file = joinPath(dir, GLOSSARY);
    const head = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
    const st = existsSync(file) ? statSync(file) : undefined;
    const key = `${head}|${st?.mtimeMs ?? 0}|${st?.size ?? 0}`;
    if (glossaryCache?.key !== key) glossaryCache = { key, view: glossaryOf(dir) };
    return glossaryCache.view;
  };
  /** A knowledge page: its content, then the drafts strip (every page commits the same way). */
  const knowledgePage = async (r: Request, title: string, content: Html, back: string) =>
    page(
      r,
      200,
      { title, page: "knowledge" },
      html`${content}${draftsHtml(await draftsOf(), back, actions)}`,
    );
  /** Standards and skills are files people write: a broken one is said on the page, not a 500. */
  const loadError = (error: unknown): Html =>
    html`<div class="banner bad">${(error as Error)?.message ?? String(error)}</div>`;
  const knowledgeGet = async (r: Request): Promise<void> => {
    if (!root || !existsSync(root))
      return notFound(r, "Knowledge needs a repository: start jarvis ui in one.");
    const at = r.url.pathname.replace(/\/+$/, "") || "/knowledge";
    const q = (name: string) => r.url.searchParams.get(name) ?? undefined;
    const counts = countsOf();
    const notice = knowledgeNotice(r);
    const usage = usageOf(runtime);
    if (at === "/knowledge") {
      const query = q("q")?.trim().slice(0, 300);
      let result: RetrievalResult | undefined;
      let searchError: string | undefined;
      if (query) {
        try {
          await refreshIndex(runtime, roots());
          result = await search(runtime, roots(), query, { limit: 10 });
        } catch (error) {
          searchError = `The search failed: ${(error as Error)?.message ?? String(error)}`;
        }
      }
      const tree = await treeOf();
      const toResearch = researchFirst(tree.modules);
      const candidates = candidatesOf(runtime, (run) => run.workflow === "onboard-module").filter(
        (c) => !c.decision && c.doc.module,
      ).length;
      const glossary = await glossaryView();
      const content = overviewContent(
        {
          counts,
          docs: await docsOf(roots(), usage),
          glossaryProblems: glossary.rows.filter((x) => x.problems.length > 0).length,
          toResearch,
          candidates,
          ...(query ? { query } : {}),
          ...(result ? { result } : {}),
          ...(searchError ? { searchError } : {}),
        },
        notice,
      );
      return knowledgePage(r, query ? `Knowledge · ${query}` : "Knowledge", content, "/knowledge");
    }
    if (at === "/knowledge/docs") {
      const docs = await docsOf(roots(), usage);
      const want = q("doc");
      const selected = want ? docs.find((d) => d.path === want) : docs[0];
      const content = docsContent(
        {
          counts,
          docs,
          ...(selected ? { selected } : {}),
          ...(want ? { path: want } : {}),
          architecture: selected?.path === ARCHITECTURE,
        },
        actions,
        notice,
      );
      return knowledgePage(
        r,
        selected ? `Knowledge · ${selected.path}` : "Knowledge · documents",
        content,
        r.url.pathname + r.url.search,
      );
    }
    if (at === "/knowledge/standards") {
      let content: Html;
      try {
        const standards = standardsOf(runtime, roots(), usage);
        const severity = q("severity");
        const sev = severity === "required" || severity === "recommended" ? severity : undefined;
        const id = q("id");
        const selected = id
          ? standards.find((s) => s.id === id)
          : standards.find((s) => !sev || s.severity === sev);
        content = standardsContent(
          { counts, standards, ...(selected ? { selected } : {}), ...(sev ? { severity: sev } : {}) },
          actions,
          notice,
        );
      } catch (error) {
        content = html`${knowledgeTabs("standards", counts)}${loadError(error)}`;
      }
      return knowledgePage(r, "Knowledge · standards", content, r.url.pathname + r.url.search);
    }
    if (at === "/knowledge/skills") {
      let content: Html;
      try {
        const skills = skillsOf(roots(), usage);
        const id = q("id");
        const selected = id
          ? skills.find((s) => `${s.skill.id}${s.overridden ? "@builtin" : ""}` === id)
          : skills[0];
        content = skillsContent({ counts, skills, ...(selected ? { selected } : {}) }, actions, notice);
      } catch (error) {
        content = html`${knowledgeTabs("skills", counts)}${loadError(error)}`;
      }
      return knowledgePage(r, "Knowledge · skills", content, r.url.pathname + r.url.search);
    }
    if (at === "/knowledge/glossary") {
      const glossary = await glossaryView();
      const term = q("term");
      const selected = term ? glossary.rows.find((x) => x.term === term) : undefined;
      const where = selected ? [...(await checkSymbols(root, selected.symbols)).values()] : undefined;
      const add = q("add");
      const content = glossaryContent(
        {
          counts,
          glossary,
          ...(selected ? { selected } : {}),
          ...(where ? { where } : {}),
          problems: q("problems") === "1",
          ...(q("q") ? { filter: q("q") as string } : {}),
          ...(add
            ? { form: { term: add.slice(0, 80), synonyms: "", symbols: "", sources: "", definition: "" } }
            : {}),
        },
        actions,
        notice,
      );
      return knowledgePage(
        r,
        term ? `Glossary · ${term}` : "Knowledge · glossary",
        content,
        r.url.pathname + r.url.search,
      );
    }
    return notFound(r, `Nothing at ${r.url.pathname}.`);
  };
  /** Add a term: check its symbols first; one that is not in the code asks for «Add anyway». */
  const glossaryPost = async (r: Request, form: URLSearchParams): Promise<void> => {
    const dir = root as string;
    const list = (name: string) =>
      (form.get(name) ?? "")
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 30);
    const values = {
      term: (form.get("term") ?? "").trim().slice(0, 80),
      synonyms: (form.get("synonyms") ?? "").trim().slice(0, 400),
      symbols: (form.get("symbols") ?? "").trim().slice(0, 400),
      sources: (form.get("sources") ?? "").trim().slice(0, 200),
      definition: (form.get("definition") ?? "").trim().slice(0, 600),
    };
    const checks = [...(await checkSymbols(dir, list("symbols"))).values()];
    const again = async (error?: string) =>
      knowledgePage(
        r,
        "Knowledge · glossary",
        glossaryContent(
          {
            counts: countsOf(),
            glossary: await glossaryView(),
            problems: false,
            form: values,
            checks,
            ...(error ? { error } : {}),
          },
          actions,
        ),
        "/knowledge/glossary",
      );
    const doing = form.get("do");
    if (!values.term) return again("Say the term");
    if (doing === "check" || (doing === "add" && checks.some((c) => !c.found))) return again();
    try {
      addGlossaryTerm(dir, {
        term: values.term,
        synonyms: list("synonyms"),
        symbols: list("symbols"),
        sources: list("sources"),
        ...(values.definition ? { definition: values.definition } : {}),
      });
    } catch (error) {
      if (!(error instanceof GlossaryTermTaken)) throw error;
      return again(error.message);
    }
    glossaryCache = undefined;
    return redirect(r, `/knowledge/glossary?term=${encodeURIComponent(values.term)}&notice=term-added`);
  };

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
    const launch = launcher.start({ task, workflow, repoRoot: repo });
    // straight to the launch: it becomes the run's page as soon as the run begins
    return redirect(r, `/launches/${launch.id}`);
  };

  /** Accept / Send back / Run again / Open in editor: the same functions as the terminal's keys. */
  const post = async (r: Request): Promise<void> => {
    if (r.url.pathname === "/runs/new") return startTask(r);
    if (r.url.pathname.startsWith("/knowledge/")) return knowledgePost(r);
    if (r.url.pathname === "/mcp/check") {
      if (!actions) return notFound(r, "Nothing to do at /mcp/check.");
      const sent = (await formOf(r.req)).get("t");
      if (!sent || !same(sent, token)) return send(r, 403, forbiddenPage());
      void checkMcp();
      return send(r, 202, mcpJson ?? PENDING_MCP, "application/json; charset=utf-8", {
        "Cache-Control": "no-store",
      });
    }
    const m = /^\/runs\/([^/]+)\/(decide|rerun|open|budget|resume|cancel)$/.exec(r.url.pathname);
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
    if (m[2] === "cancel") {
      // as `jarvis cancel`: at once when nothing executes it, else at its next safe point (ADR-0002 §6)
      if (isTerminal(run.state)) return redirect(r, `/runs/${short}?notice=already-ended`);
      const who = await actor();
      const updated = runtime.runs.requestCancel(run.id);
      runtime.events.emit({
        kind: "run.cancel",
        runId: run.id,
        ...(who ? { actor: `${who.kind}:${who.id}` } : {}),
        payload: { immediate: updated.state === "CANCELLED", by: "ui" },
      });
      return redirect(
        r,
        `/runs/${short}?notice=${updated.state === "CANCELLED" ? "cancelled" : "cancel-requested"}`,
      );
    }
    if (m[2] === "resume") {
      // a run parked on a quota window or a model: try now (it parks again if the window is still full)
      const back = (form.get("back") ?? "").startsWith("/knowledge/")
        ? (form.get("back") as string)
        : `/runs/${short}`;
      const sep = back.includes("?") ? "&" : "?";
      if (run.state !== "WAITING_BUDGET") return redirect(r, `${back}${sep}notice=not-waiting`);
      if (!options.launcher) return redirect(r, `${back}${sep}notice=no-launcher`);
      return redirect(r, `${back}${sep}notice=${options.launcher.adopt(run) ? "resumed" : "resuming"}`);
    }
    if (m[2] === "budget") {
      const stop = budgetStopOf(runtime, run);
      if (!stop) return redirect(r, `/runs/${short}?notice=not-waiting`);
      const choice = form.get("choice");
      const more = Number(form.get("amount"));
      if (choice !== "finish" && !(choice === "more" && Number.isInteger(more) && more > 0))
        return redirect(r, `/runs/${short}?notice=amount`);
      if (!budgetGranted(runtime, run.id)) {
        const who = await actor();
        if (!who) return redirect(r, `/runs/${short}?notice=actor`);
        grantBudget(runtime, run, stop, who, choice === "finish" ? { finish: true } : { more }, "ui");
      }
      options.launcher?.resume(run); // a run the page started goes on in the background
      return redirect(r, `/runs/${short}`);
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
    if (path === "/knowledge/modules") return modulesPageOf(r);
    if (path === "/knowledge" || path.startsWith("/knowledge/")) return knowledgeGet(r);
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
      // the header's indicator: answered from the last computed state at once, never computed here
      if (!modelsJson) scheduleHealth(0);
      return send(r, 200, modelsJson ?? PENDING_MODELS, "application/json; charset=utf-8", {
        "Cache-Control": "no-store",
      });
    }
    if (path === "/waiting.json") {
      // the page's system notifications: the runs that wait for a person, each stop with its own key
      const waiting: Array<{
        id: string;
        task: string;
        workflow: string;
        what: string;
        parked: string | number | undefined;
        terminal: boolean;
        href?: string;
      }> = runtime.runs.list({ state: ["WAITING_HUMAN"], limit: 200 }).map((run) => ({
        id: shortRunId(run.id),
        task: (run.task.split("\n")[0] ?? "").trim().slice(0, 140),
        workflow: run.workflow,
        what: waitingWhat(run),
        parked: parkedAt(runtime, run.id),
        terminal: waitingCard(runtime, run.id) !== undefined,
      }));
      // module research whose candidate waits for a review on the Modules page
      for (const c of candidatesOf(runtime, (run) => run.workflow === "onboard-module")) {
        if (c.decision || !c.doc.module) continue;
        waiting.push({
          id: shortRunId(c.artifact.runId),
          task: `module ${c.doc.module}`,
          workflow: "onboard-module",
          what: "review what the research found",
          parked: c.artifact.artifactId,
          terminal: false,
          href: `/knowledge/modules?path=${encodeURIComponent(c.doc.module)}`,
        });
      }
      return send(r, 200, JSON.stringify({ waiting }), "application/json; charset=utf-8", {
        "Cache-Control": "no-store",
      });
    }
    if (path === "/mcp.json") {
      if (!mcpJson) computeMcp();
      return send(r, 200, mcpJson ?? PENDING_MCP, "application/json; charset=utf-8", {
        "Cache-Control": "no-store",
      });
    }
    const launchAt = /^\/launches\/([0-9a-f]+)$/.exec(path);
    if (launchAt) {
      const launch = options.launcher?.get(launchAt[1] as string);
      if (!launch) return notFound(r, "No such launch (they live as long as this jarvis ui).");
      options.launcher?.tend();
      // the run began: this is its page now
      if (launch.runId) return redirect(r, `/runs/${shortRunId(launch.runId)}`);
      return page(
        r,
        200,
        {
          title: `Starting · ${launch.task.slice(0, 60)}`,
          page: "run",
          back: { href: "/", label: "Runs" },
          // refreshed in place (the header and its popover stay); the run's page once the run begins
          ...(launch.exitCode === null ? { refresh: 2, tick: 2000 } : {}),
        },
        launchContent(
          {
            id: launch.id,
            task: launch.task,
            workflow: launch.workflow,
            startedAt: launch.startedAt,
            exitCode: launch.exitCode,
            log: launch.log,
            tail: options.launcher?.tail(launch, 40) ?? "",
            repo: launch.repoRoot,
          },
          now,
          options.homeDir,
        ),
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
        clearInterval(healthTimer);
        clearInterval(mcpTimer);
        if (mcpChecker) clearInterval(mcpChecker);
        if (healthSoon) clearTimeout(healthSoon);
        for (const c of clients) c.end();
        clients.clear();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
