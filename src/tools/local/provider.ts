import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Diagnostic } from "../../core/capabilities/contracts.ts";
import type { ResolvedConfig } from "../../core/config/schema.ts";
import { changedFiles } from "../../knowledge/check.ts";
import { globMatches } from "../../knowledge/frontmatter.ts";
import {
  currentSymbols,
  findSymbol,
  OUTLINE_ABOVE_LINES,
  outlineText,
} from "../../knowledge/graph/outline.ts";
import { readByRef } from "../../knowledge/resolver.ts";
import { UNIT_KINDS } from "../../knowledge/retrieval/index.ts";
import { refreshIndex, search } from "../../knowledge/retrieval/service.ts";
import { knowledgeRootsOf } from "../../knowledge/sources.ts";
import { diagnosticsIn, diagnosticsText, parseDiagnostics } from "../../orchestration/tools/diagnostics.ts";
import { gitIdentityEnv } from "../../orchestration/worktree.ts";
import { effectMarker } from "../../storage/effects.ts";
import type { Capability, ToolContext, ToolOutput, ToolProvider } from "../types.ts";
import { projectArgs } from "./args.ts";
import { git, hasRipgrep, runCommand, runShell } from "./exec.ts";
import { filesFor, rulesFor } from "./fix.ts";
import { PathDeniedError, resolveInWorkspace } from "./paths.ts";
import { isScratchFile } from "./scratch.ts";

/**
 * Local tool provider (ADR-0001 §9): file system, search, git and project commands — all
 * confined to the workspace, all `network: none`.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".jarvis", "dist", "coverage", ".pnpm-store"]);

/**
 * `git.diff` of the whole change: the files it touches, then the code's diff within this size; tests,
 * snapshots and lockfiles by name only (git.diff with their path shows them). Pilot: a 62 KB diff,
 * cut at the tool limit, was asked for five times in one run and stayed in each conversation.
 */
const DIFF_CHARS = 24_000;
const DIFF_ASIDE = [
  "**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/__snapshots__/**",
  "**/*.snap",
  "**/{package-lock.json,yarn.lock,pnpm-lock.yaml,npm-shrinkwrap.json}",
];

/**
 * `repo.list` without `recursive`: one level — the folders with how many files each holds, then the
 * files. Pilot: a package's root listed recursively, 41 KB, stayed in the conversation for 60 calls.
 */
export function oneLevel(files: readonly string[], prefix: string): string[] {
  const dirs = new Map<string, number>();
  const here: string[] = [];
  for (const f of files) {
    const rest = f.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) here.push(f);
    else {
      const dir = `${prefix}${rest.slice(0, slash)}/`;
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
  }
  return [...[...dirs.entries()].map(([d, n]) => `${d} (${n} file${n === 1 ? "" : "s"})`), ...here];
}

/**
 * An artifact of this run (or of the run it went on from) by `art_…@v`, or by `type/name@v` as the task
 * message lists it — also `artifact:type/name@v` and `name@v`. Pilot: the inputs «available on request»
 * were named `design/design.md@1`, and knowledge.read knew only artifact ids.
 */
function artifactByRef(ctx: ToolContext, raw: string) {
  const ref = raw.replace(/^artifact:/, "");
  const m = /^([A-Za-z0-9_.:/-]+)@(\d+)$/.exec(ref);
  if (!m || /^(standard|skill|knowledge):/.test(ref)) return undefined;
  const [, id, v] = m as unknown as [string, string, string];
  const version = Number(v);
  const created = ctx.runtime.events.list({ runId: ctx.run.id, kind: "run.created", limit: 1 })[0];
  const from = (created?.payload as { continuedFrom?: string } | undefined)?.continuedFrom;
  const runs = [ctx.run.id, ...(from ? [from] : [])];
  const byId = ctx.runtime.artifacts.get(id, version);
  if (byId && runs.includes(byId.runId)) return byId;
  const slash = id.indexOf("/");
  const [type, name] = slash > 0 ? [id.slice(0, slash), id.slice(slash + 1)] : [undefined, id];
  for (const runId of runs) {
    const latest = ctx.runtime.artifacts
      .listLatest(runId, type)
      .find((a) => a.name === name || (type === undefined && a.name === id));
    if (!latest) continue;
    const exact = ctx.runtime.artifacts.get(latest.artifactId, version);
    if (exact) return exact;
  }
  return undefined;
}

/** `documentation/x.md`, `knowledge:x` → the refs a knowledge document may be known by. */
function refCandidates(ref: string): string[] {
  const out = [ref];
  if (!/^(standard|skill|knowledge):/.test(ref)) out.push(`knowledge:${ref}`);
  const named = out.at(-1) as string;
  if (named.startsWith("knowledge:") && !/\.md$/.test(named)) out.push(`${named}.md`);
  return out;
}

function fail(error: unknown): ToolOutput {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * Text files end with a newline, as nearly every linter wants (`eol-last`). A model's tool arguments
 * can lose a string's trailing newline — the pilot model never delivered one, and an agent spent two
 * rounds and a dozen probe files failing to satisfy the linter. A file that ended with a newline
 * keeps one; a new file gets one; a file that existed without one stays so.
 */
export function withFinalNewline(content: string, before: string | undefined): string {
  if (content === "" || content.endsWith("\n")) return content;
  if (before !== undefined && before !== "" && !before.endsWith("\n")) return content;
  return `${content}\n`;
}

function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing argument "${key}"`);
  }
  return String(v);
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

async function listFiles(ctx: ToolContext, root: string): Promise<string[]> {
  const inGit = await git(["rev-parse", "--is-inside-work-tree"], root);
  if (inGit.code === 0) {
    const r = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root);
    if (r.code === 0) return r.stdout.split("\0").filter((f) => f.length > 0 && !ctx.pathPolicy.isDenied(f));
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const rel = relative(root, join(dir, entry.name)).split("\\").join("/");
        if (!ctx.pathPolicy.isDenied(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

export class LocalToolProvider implements ToolProvider {
  readonly name = "local";
  private readonly config: ResolvedConfig;
  /** Per checkout and rebuild command: the state of its sources at the last build (src/orchestration/tools/rebuild.ts). */
  private readonly built = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * `knowledge.search`: the index brought up to date once per step, and again after a write — not on
   * every search (each refresh reads every knowledge document and the run's artifacts, and asks git).
   */
  private readonly indexed = new Map<string, string>();
  private writes = 0;
  /** `code.diagnostics`: each checker's output for a state of the workspace (its fingerprint). */
  private readonly diagnosed = new Map<string, { at: string; out: ToolOutput }>();

  constructor(config: ResolvedConfig) {
    this.config = config;
  }

  capabilities(): readonly Capability[] {
    const caps: Capability[] = [
      {
        name: "repo.read",
        description: `Read a file inside the workspace. Optional 1-based startLine/endLine, or symbol: a class or method of the file ("OrderService.find") — its lines. A file over ${OUTLINE_ABOVE_LINES} lines whose classes and methods are known comes as its outline (each with its lines) unless full: true.`,
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            symbol: {
              type: "string",
              description: 'a class or method of the file, e.g. "OrderService.find"',
            },
            full: { type: "boolean", description: "the whole file even when it is long" },
          },
          required: ["path"],
        },
        handler: async (args, ctx) => {
          try {
            const { absolute, relative: rel } = resolveInWorkspace(ctx, str(args, "path"));
            const buffer = readFileSync(absolute);
            if (isProbablyBinary(buffer))
              return { ok: false, error: `${rel} is binary (${buffer.length} bytes)` };
            const content = buffer.toString("utf8");
            const lines = content.split("\n");
            const ranged = args.startLine !== undefined || args.endLine !== undefined;
            const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
            // classes and methods with their lines, from the stack's extractor on the file as it is now
            const extractors = () =>
              (ctx.runtime.capabilities?.list() ?? [])
                .map((a) => a.graphExtractor?.())
                .filter((x) => x !== undefined);
            if (symbol && !ranged) {
              const symbols = await currentSymbols(extractors(), rel, content);
              const found = findSymbol(symbols, symbol);
              if (found.length === 0)
                return {
                  ok: false,
                  error: `no "${symbol}" in ${rel}${
                    symbols.length > 0
                      ? `; it has: ${symbols
                          .map((x) => x.name.replace(/\/-?\d+$/, ""))
                          .slice(0, 30)
                          .join(", ")}`
                      : " (no outline for this file: read it by lines)"
                  }`,
                };
              const text = found
                .map((f) => {
                  const body = lines
                    .slice(f.line - 1, f.endLine)
                    .map((l, i) => `${String(f.line + i).padStart(5)}  ${l}`)
                    .join("\n");
                  return `${f.name} (${rel}:${f.line}-${f.endLine})\n${body}`;
                })
                .join("\n\n");
              return {
                ok: true,
                text,
                data: { path: rel, lines: lines.length, symbol: found.map((f) => f.name) },
              };
            }
            if (!ranged && args.full !== true && lines.length > OUTLINE_ABOVE_LINES) {
              const symbols = await currentSymbols(extractors(), rel, content);
              if (symbols.filter((x) => x.kind === "method").length >= 2)
                return {
                  ok: true,
                  text: outlineText(rel, lines.length, symbols),
                  data: {
                    path: rel,
                    lines: lines.length,
                    outline: true,
                    // the whole file, as a task message shows it: a file the agent has there needs no outline
                    fileHash: createHash("sha256")
                      .update(lines.map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n"))
                      .digest("hex"),
                  },
                };
            }
            const start = Math.max(1, num(args, "startLine", 1));
            const end = Math.min(lines.length, num(args, "endLine", lines.length));
            const slice = lines.slice(start - 1, end);
            const text = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
            return {
              ok: true,
              text,
              data: { path: rel, lines: lines.length, startLine: start, endLine: end },
            };
          } catch (error) {
            return fail(error);
          }
        },
      },
      {
        name: "knowledge.read",
        description:
          "Read in full by ref: a standard, skill or knowledge document listed as available on request (standard:ID@v, skill:id@v, knowledge:name), an artifact of this run (artifactId@version), a code hit of knowledge.search (path:start-end), or the original of trimmed/compacted context (blob:<ref>).",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: { ref: { type: "string", description: "e.g. standard:STD-CS-01@2" } },
          required: ["ref"],
        },
        handler: async (args, ctx) => {
          const ref = str(args, "ref").trim();
          // Originals of trimmed/compacted context and earlier artifacts (ADR-0001 §7: sources survive summaries).
          if (ref.startsWith("blob:")) {
            const contentRef = ctx.runtime.blobs.resolve(ref.slice("blob:".length).replace(/…$/, ""));
            return contentRef
              ? { ok: true, text: ctx.runtime.blobs.getText(contentRef) }
              : { ok: false, error: `unknown blob "${ref.slice("blob:".length)}"` };
          }
          const artifact = artifactByRef(ctx, ref);
          if (artifact) return { ok: true, text: ctx.runtime.artifacts.text(artifact) };
          // a code hit of knowledge.search: `path:start-end` (ADR-0015 §2 v0.4)
          const code = ctx.run.workflow === "ask" ? null : /^(.+):(\d+)-(\d+)$/.exec(ref);
          if (code) {
            try {
              const { absolute, relative: rel } = resolveInWorkspace(ctx, code[1] as string);
              if (existsSync(absolute) && statSync(absolute).isFile()) {
                const start = Number(code[2]);
                const lines = readFileSync(absolute, "utf8")
                  .split("\n")
                  .slice(start - 1, Number(code[3]));
                return {
                  ok: true,
                  text: `${rel}:${start}-${start + lines.length - 1}\n${lines.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n")}`,
                };
              }
            } catch (error) {
              return fail(error);
            }
          }
          const roots = knowledgeRootsOf(ctx.runtime.loaded, ctx.workspacePath);
          // a knowledge document named without its prefix or extension (pilot: 13 failed reads)
          for (const candidate of refCandidates(ref)) {
            const text = readByRef(roots, candidate);
            if (text !== undefined) return { ok: true, text };
          }
          return { ok: false, error: `unknown ref "${ref}"` };
        },
      },
      {
        name: "knowledge.search",
        description:
          "Search project knowledge, standards, skills, this run's artifacts and the code (by symbol) by words, with business terms expanded through the project glossary; returns refs for knowledge.read (code: path:start-end).",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
            kinds: {
              type: "array",
              items: { type: "string", enum: [...UNIT_KINDS] },
              description: 'only these kinds of source, e.g. ["code"]',
            },
          },
          required: ["query"],
        },
        handler: async (args, ctx) => {
          const roots = knowledgeRootsOf(ctx.runtime.loaded, ctx.workspacePath);
          const at = `${ctx.stepId}#${ctx.iteration}:${this.writes}`;
          if (this.indexed.get(ctx.run.id) !== at) {
            await refreshIndex(ctx.runtime, roots, ctx.run.id);
            this.indexed.set(ctx.run.id, at);
          }
          // `jarvis ask` answers from the knowledge base alone: its answerer is never shown code
          const allowed = ctx.run.workflow === "ask" ? UNIT_KINDS.filter((k) => k !== "code") : UNIT_KINDS;
          const asked = Array.isArray(args.kinds)
            ? allowed.filter((k) => (args.kinds as unknown[]).includes(k))
            : [];
          const kinds = asked.length > 0 || ctx.run.workflow !== "ask" ? asked : allowed;
          const result = await search(ctx.runtime, roots, str(args, "query"), {
            limit: num(args, "limit", 10),
            ...(kinds.length > 0 ? { kinds } : {}),
          });
          const lines = result.evidence.map(
            (e, i) =>
              `${i + 1}. ${e.ref}  [${e.kind}] ${e.title}${e.snippet ? ` — ${e.snippet.replace(/\s+/g, " ")}` : ""}  (${e.retrievalPath.map((p) => `${p.index}#${p.rank}`).join(",")})`,
          );
          if (result.expansions.length > 0)
            lines.unshift(
              `glossary expansions: ${result.expansions.map((x) => `${x.term} → ${x.added.join(", ")}`).join("; ")}`,
            );
          return { ok: true, text: lines.length > 0 ? lines.join("\n") : "no matches", data: result };
        },
      },
      {
        name: "repo.list",
        description:
          "List a folder of the workspace (tracked and untracked, ignoring .gitignore'd files): its folders with their file counts, then its files. recursive=true lists every file below it.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            recursive: { type: "boolean" },
            maxEntries: { type: "integer" },
          },
        },
        handler: async (args, ctx) => {
          try {
            const { absolute, relative: rel } = resolveInWorkspace(ctx, str(args, "path", "."));
            const all = await listFiles(ctx, ctx.workspacePath);
            const prefix = rel === "." ? "" : `${rel}/`;
            const below = all.filter((f) => f.startsWith(prefix));
            const files = args.recursive === true ? below : oneLevel(below, prefix);
            const max = num(args, "maxEntries", 500);
            void absolute;
            return {
              ok: true,
              text: files.slice(0, max).join("\n"),
              data: { total: files.length, shown: Math.min(max, files.length), files: below.length },
            };
          } catch (error) {
            return fail(error);
          }
        },
      },
      {
        name: "repo.search",
        description:
          "Search file contents (ripgrep when available). `pattern` is a regex unless literal=true. For code by words or business terms rather than an exact pattern, knowledge.search ranks it by symbol.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            glob: { type: "string" },
            literal: { type: "boolean" },
            maxResults: { type: "integer" },
          },
          required: ["pattern"],
        },
        handler: async (args, ctx) => {
          try {
            const pattern = str(args, "pattern");
            const { relative: rel } = resolveInWorkspace(ctx, str(args, "path", "."));
            const max = num(args, "maxResults", 200);
            const literal = args.literal === true;
            const globArg = typeof args.glob === "string" ? args.glob : undefined;
            if (await hasRipgrep()) {
              const rgArgs = [
                "--line-number",
                "--no-heading",
                "--color",
                "never",
                "--max-count",
                "50",
                "-m",
                "50",
              ];
              if (literal) rgArgs.push("--fixed-strings");
              if (globArg) rgArgs.push("--glob", globArg);
              for (const d of SKIP_DIRS) rgArgs.push("--glob", `!${d}`);
              // from the workspace root, so `path` may be a file as well as a directory (pilot: a file
              // path made rg start in it — spawn ENOTDIR) and every hit carries its path from the root
              rgArgs.push("--with-filename", "-e", pattern, rel === "." ? "." : rel);
              const r = await runCommand("rg", rgArgs, { cwd: ctx.workspacePath, timeoutMs: 60_000 });
              if (r.code !== 0 && r.code !== 1)
                return { ok: false, error: r.stderr || `rg exited ${r.code}` };
              const lines = r.stdout
                .split("\n")
                .filter((l) => l.length > 0)
                .map((l) => l.replace(/^\.\//, ""))
                .filter((l) => !ctx.pathPolicy.isDenied(l.split(":")[0] ?? ""));
              return {
                ok: true,
                text: lines.slice(0, max).join("\n"),
                data: { matches: lines.length, shown: Math.min(max, lines.length), engine: "rg" },
              };
            }
            const re = literal
              ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              : new RegExp(pattern);
            const files = (await listFiles(ctx, ctx.workspacePath)).filter(
              (f) => rel === "." || f === rel || f.startsWith(`${rel}/`),
            );
            const hits: string[] = [];
            for (const f of files) {
              if (
                globArg &&
                !new RegExp(`^${globArg.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*")}$`).test(f) &&
                !f.endsWith(globArg.replace(/^\*/, ""))
              )
                continue;
              const buffer = readFileSync(join(ctx.workspacePath, f));
              if (isProbablyBinary(buffer)) continue;
              buffer
                .toString("utf8")
                .split("\n")
                .forEach((line, i) => {
                  if (re.test(line)) hits.push(`${f}:${i + 1}:${line}`);
                });
              if (hits.length >= max) break;
            }
            return {
              ok: true,
              text: hits.slice(0, max).join("\n"),
              data: { matches: hits.length, shown: Math.min(max, hits.length), engine: "js" },
            };
          } catch (error) {
            return fail(error);
          }
        },
      },
      {
        // ADR-0023: the page shows which plan step an implementation is on (src/app/planProgress.ts)
        name: "plan.step",
        description:
          "Mark where you are in the plan: status start before working on a plan step, done after its verification. No effect on the workspace; send it together with your other calls.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            step: { type: "string", description: "the plan step's id" },
            status: { type: "string", enum: ["start", "done"] },
          },
          required: ["step", "status"],
        },
        handler: async (args) => {
          const step = typeof args.step === "string" ? args.step.trim() : "";
          const status = args.status === "done" ? "done" : "start";
          if (!step) return { ok: false, error: "name the plan step: its id from the plan" };
          return { ok: true, text: `noted: plan step ${step} ${status === "done" ? "done" : "started"}` };
        },
      },
      {
        name: "repo.write",
        description: `Create or overwrite a file inside the workspace. A text file is ended with a newline.${this.fixNote()}`,
        network: "none",
        access: "write",
        effect: false,
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        handler: async (args, ctx) => {
          try {
            const { absolute, relative: rel } = resolveInWorkspace(ctx, str(args, "path"));
            if (!existsSync(absolute) && isScratchFile(rel)) {
              return {
                ok: false,
                error: `${rel} looks like a scratch file (tmp-*, *probe*, scratch*): the workspace holds only the change itself; name a real file or leave the experiment out`,
              };
            }
            mkdirSync(dirname(absolute), { recursive: true });
            const before = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
            const content = withFinalNewline(str(args, "content"), before);
            writeFileSync(absolute, content, "utf8");
            this.writes += 1;
            const fixed = await this.fixWritten(rel, absolute, ctx);
            return {
              ok: true,
              text: `wrote ${rel} (${Buffer.byteLength(content)} bytes)${fixed.text}`,
              data: { path: rel, ...(fixed.data ? { fix: fixed.data } : {}) },
            };
          } catch (error) {
            return fail(error);
          }
        },
      },
      {
        name: "repo.edit",
        description: `Replace an exact text fragment in a file. Fails if the fragment is missing or ambiguous unless replaceAll=true.${this.fixNote()}`,
        network: "none",
        access: "write",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            oldText: { type: "string" },
            newText: { type: "string" },
            replaceAll: { type: "boolean" },
          },
          required: ["path", "oldText", "newText"],
        },
        handler: async (args, ctx) => {
          try {
            const { absolute, relative: rel } = resolveInWorkspace(ctx, str(args, "path"));
            const oldText = str(args, "oldText");
            const newText = str(args, "newText");
            const current = readFileSync(absolute, "utf8");
            const occurrences = current.split(oldText).length - 1;
            if (occurrences === 0) return { ok: false, error: `fragment not found in ${rel}` };
            if (occurrences > 1 && args.replaceAll !== true)
              return {
                ok: false,
                error: `fragment occurs ${occurrences} times in ${rel}; pass replaceAll=true or make it unique`,
              };
            const replaced =
              args.replaceAll === true
                ? current.split(oldText).join(newText)
                : current.replace(oldText, () => newText);
            // an edited text file ends with a newline (see withFinalNewline): an edit at the end must not
            // take it away, and a file written without one is mended by the next edit
            const next = withFinalNewline(replaced, undefined);
            writeFileSync(absolute, next, "utf8");
            this.writes += 1;
            const fixed = await this.fixWritten(rel, absolute, ctx);
            return {
              ok: true,
              text: `edited ${rel} (${occurrences} replacement${occurrences > 1 ? "s" : ""})${fixed.text}`,
              data: { path: rel, replacements: occurrences, ...(fixed.data ? { fix: fixed.data } : {}) },
            };
          } catch (error) {
            return fail(error);
          }
        },
      },
      {
        name: "git.status",
        description: "git status of the workspace (porcelain).",
        network: "none",
        access: "read",
        effect: false,
        parameters: { type: "object", properties: {} },
        handler: async (_args, ctx) => {
          const r = await git(["status", "--porcelain=v1", "--branch"], ctx.workspacePath);
          return r.code === 0 ? { ok: true, text: r.stdout } : { ok: false, error: r.stderr };
        },
      },
      {
        name: "git.diff",
        description:
          "Diff of the workspace against a base (default: the run's base commit) or the index. Without path: the changed files, then the code's diff (tests, snapshots and lockfiles by name — pass their path); path — one file or folder in full; full=true — everything.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            base: { type: "string" },
            path: { type: "string" },
            staged: { type: "boolean" },
            full: { type: "boolean" },
          },
        },
        handler: async (args, ctx) => {
          const base = typeof args.base === "string" ? args.base : ctx.run.workspace.baseCommit;
          const gitArgs = ["diff", "--no-color"];
          if (args.staged === true) gitArgs.push("--cached");
          else if (base) gitArgs.push(base);
          const whole = async (extra: string[] = []): Promise<ToolOutput> => {
            const r = await git([...gitArgs, ...extra], ctx.workspacePath);
            return r.code === 0 ? { ok: true, text: r.stdout } : { ok: false, error: r.stderr };
          };
          if (typeof args.path === "string")
            return whole(["--", resolveInWorkspace(ctx, args.path).relative]);
          if (args.full === true) return whole();
          const names = await git([...gitArgs, "--name-only"], ctx.workspacePath);
          if (names.code !== 0) return { ok: false, error: names.stderr };
          const files = names.stdout.split("\n").filter((f) => f.length > 0);
          const aside = files.filter((f) => globMatches(f, DIFF_ASIDE));
          const code = files.filter((f) => !aside.includes(f));
          const stat = await git([...gitArgs, "--stat=120"], ctx.workspacePath);
          const diff =
            code.length > 0 ? await git([...gitArgs, "--", ...code], ctx.workspacePath) : undefined;
          const chunks = (diff?.stdout ?? "").split(/^(?=diff --git )/m).filter((c) => c.length > 0);
          const shown: string[] = [];
          const later: string[] = [];
          let left = DIFF_CHARS;
          for (const chunk of chunks) {
            const file = /^diff --git a\/(\S+)/.exec(chunk)?.[1] ?? "?";
            if (chunk.length <= left) {
              shown.push(chunk);
              left -= chunk.length;
            } else later.push(file);
          }
          const untracked = await git(["ls-files", "--others", "--exclude-standard"], ctx.workspacePath);
          const fresh = untracked.stdout
            .split("\n")
            .filter((f) => f.length > 0 && !ctx.pathPolicy.isDenied(f));
          const notes = [
            later.length > 0
              ? `[not shown, over ${DIFF_CHARS} chars: ${later.join(", ")} — git.diff with their path]`
              : "",
            aside.length > 0
              ? `[tests, snapshots, lockfiles — git.diff with their path: ${aside.join(", ")}]`
              : "",
            fresh.length > 0
              ? `[new files not committed yet, not in a diff — repo.read them: ${fresh.join(", ")}]`
              : "",
          ].filter(Boolean);
          return {
            ok: true,
            text: [stat.stdout.trimEnd(), shown.join(""), ...notes].filter(Boolean).join("\n\n"),
            data: { files: files.length, shown: shown.length, later: later.length, aside: aside.length },
          };
        },
      },
      {
        name: "git.log",
        description: "Recent commits of the workspace branch.",
        network: "none",
        access: "read",
        effect: false,
        parameters: { type: "object", properties: { n: { type: "integer" }, path: { type: "string" } } },
        handler: async (args, ctx) => {
          const gitArgs = [
            "log",
            "--no-color",
            `--max-count=${num(args, "n", 20)}`,
            "--format=%h %ad %an%n    %s",
            "--date=short",
          ];
          if (typeof args.path === "string") gitArgs.push("--", resolveInWorkspace(ctx, args.path).relative);
          const r = await git(gitArgs, ctx.workspacePath);
          return r.code === 0 ? { ok: true, text: r.stdout } : { ok: false, error: r.stderr };
        },
      },
      {
        name: "git.commit",
        description: "Commit all changes in the workspace with a message (worktree mode).",
        network: "none",
        access: "write",
        effect: false,
        parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
        handler: async (args, ctx) => {
          const message = `${str(args, "message")}\n\nJarvis-Run: ${ctx.run.id}\nJarvis-Step: ${ctx.stepId}`;
          const add = await git(["add", "-A"], ctx.workspacePath);
          if (add.code !== 0) return { ok: false, error: add.stderr };
          const r = await git(["commit", "-q", "-m", message], ctx.workspacePath, {
            env: gitIdentityEnv(ctx.env, {
              name: ctx.run.owner.display ?? ctx.run.owner.id,
              email: ctx.run.owner.id,
            }),
          });
          if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
          const sha = await git(["rev-parse", "HEAD"], ctx.workspacePath);
          return {
            ok: true,
            text: `committed ${sha.stdout.trim().slice(0, 10)}`,
            data: { commit: sha.stdout.trim() },
          };
        },
      },
      {
        name: "git.push",
        description:
          "Push the workspace branch to a remote. An effect: journaled and verified by the remote ref.",
        network: "intranet",
        access: "write",
        effect: true,
        parameters: {
          type: "object",
          properties: { remote: { type: "string" }, branch: { type: "string" } },
        },
        handler: async (args, ctx) => {
          const remote = str(args, "remote", "origin");
          const branch = typeof args.branch === "string" ? args.branch : ctx.run.workspace.branch;
          if (!branch) return { ok: false, error: "no branch to push (cwd workspace)" };
          const r = await git(["push", "-u", remote, `HEAD:${branch}`], ctx.workspacePath, {
            timeoutMs: 300_000,
          });
          if (r.code !== 0) return { ok: false, error: r.stderr };
          const sha = await git(["rev-parse", "HEAD"], ctx.workspacePath);
          return {
            ok: true,
            text: `pushed ${branch} to ${remote} (${effectMarker(ctx.run.id, "")})`,
            data: { remote, branch, commit: sha.stdout.trim() },
          };
        },
        verify: async (args, _record, ctx) => {
          const remote = str(args, "remote", "origin");
          const branch = typeof args.branch === "string" ? args.branch : ctx.run.workspace.branch;
          if (!branch) return undefined;
          const local = await git(["rev-parse", "HEAD"], ctx.workspacePath);
          const remoteRef = await git(["ls-remote", remote, `refs/heads/${branch}`], ctx.workspacePath, {
            timeoutMs: 60_000,
          });
          if (remoteRef.code !== 0) return undefined;
          const sha = remoteRef.stdout.trim().split(/\s+/)[0];
          if (!sha) return "not-found";
          return sha === local.stdout.trim()
            ? { ok: true, text: `already pushed ${branch}`, data: { remote, branch, commit: sha } }
            : "not-found";
        },
      },
    ];

    // ADR-0021 §4: what the typecheck and lint say about some files, as facts (file, line, code, message)
    const checkers = Object.keys(this.config.tools.local).filter((n) => /^(typecheck|lint)/.test(n));
    if (checkers.length > 0)
      caps.push({
        name: "code.diagnostics",
        description: `Errors and warnings of the project's ${checkers.join(", ")} for some files (or all): file:line, code, message — one call instead of running the commands and reading their logs.`,
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: { type: "string" },
              description: "files to report on (a file may be named by its end); none = everything",
            },
          },
        },
        handler: async (args, ctx) => {
          const files = Array.isArray(args.files) ? args.files.map(String) : [];
          const found: Diagnostic[] = [];
          const ran: string[] = [];
          // the checkers side by side (a typecheck still waits for its rebuild), and not again for a
          // workspace as it was at the last call: the agent asks after each edit, and for each file
          const at = await workspaceFingerprint(ctx.workspacePath);
          const outs = await Promise.all(
            checkers.map(async (name) => {
              const key = `${ctx.workspacePath}\0${name}`;
              const seen = at ? this.diagnosed.get(key) : undefined;
              if (seen && seen.at === at) return { name, out: seen.out, cached: true };
              const out = await this.projectCommand(name, this.config.tools.local[name] as string, ctx);
              if (at) this.diagnosed.set(key, { at, out });
              return { name, out, cached: false };
            }),
          );
          for (const { name, out, cached } of outs) {
            ran.push(
              `${name}: ${out.ok ? "passed" : "failed"}${cached ? " (nothing changed since its last run)" : ""}`,
            );
            const text = `${out.text ?? ""}\n${out.error ?? ""}`;
            found.push(...parseDiagnostics(text, name));
          }
          const shown = diagnosticsIn(found, files);
          return {
            ok: true,
            text: `${ran.join(" · ")}\n${diagnosticsText(shown)}`,
            data: { ran, total: found.length, shown: shown.length, diagnostics: shown.slice(0, 200) },
          };
        },
      });

    for (const [name, command] of Object.entries(this.config.tools.local)) {
      caps.push({
        name: `project.${name}`,
        description: `Run the project's "${name}" command: ${command}`,
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            args: {
              type: "string",
              description:
                "extra arguments appended to the command (a file, a test path, an option); quoted for you — not shell: no pipes, redirects or chains",
            },
          },
        },
        handler: async (args, ctx) => {
          const extra =
            typeof args.args === "string" ? projectArgs(args.args) : ({ ok: true, text: "" } as const);
          if (!extra.ok) return { ok: false, error: extra.error };
          return this.projectCommand(name, `${command}${extra.text ? ` ${extra.text}` : ""}`, ctx);
        },
      });
    }

    if (this.config.tools.shell) {
      caps.push({
        name: "shell.run",
        description: "Run a shell command inside the workspace (enabled by tools.shell).",
        network: "none",
        access: "write",
        effect: false,
        parameters: {
          type: "object",
          properties: { command: { type: "string" }, timeoutMs: { type: "integer" } },
          required: ["command"],
        },
        handler: async (args, ctx) =>
          this.runProjectCommand(
            str(args, "command"),
            ctx,
            num(args, "timeoutMs", this.config.tools.commandTimeoutMs),
          ),
      });
    }
    return caps;
  }

  /**
   * A `tools.local` command. A rebuild (`tools.rebuild`) marks its sources as built; a `test*` or
   * `typecheck*` check first runs the rebuilds whose sources changed since (pilot: the implementation's
   * own typecheck passed against the library built before its change). Builds and those checks go one
   * at a time per checkout — verify runs its stages side by side.
   */
  private async projectCommand(name: string, command: string, ctx: ToolContext): Promise<ToolOutput> {
    const rebuilds = this.config.tools.rebuild;
    const isBuild = rebuilds.some((r) => r.run === name);
    if (rebuilds.length === 0 || (!isBuild && !/^(test|typecheck)/.test(name)))
      return this.runProjectCommand(command, ctx);
    return this.inTurn(ctx.workspacePath, async () => {
      if (isBuild) {
        const out = await this.runProjectCommand(command, ctx);
        if (out.ok) await this.markBuilt(name, ctx);
        return out;
      }
      const notes: string[] = [];
      for (const target of await this.staleBuilds(ctx)) {
        const build = this.config.tools.local[target];
        if (!build) continue;
        const out = await this.runProjectCommand(build, ctx);
        if (!out.ok)
          return { ...out, text: `rebuild "${target}" failed before "${name}":\n${out.text ?? ""}` };
        await this.markBuilt(target, ctx);
        notes.push(target);
      }
      const out = await this.runProjectCommand(command, ctx);
      return notes.length > 0
        ? { ...out, text: `[rebuilt first: ${notes.join(", ")}]\n${out.text ?? ""}` }
        : out;
    });
  }

  /** What the write tools say of `tools.fix`, when the project has fixers. */
  private fixNote(): string {
    return this.config.tools.fix.length > 0
      ? " Then the project's fixer runs on the file (tools.fix): formatting is fixed for you, and what it cannot fix comes back in the result — fix that before you go on."
      : "";
  }

  /**
   * `tools.fix` on a file an agent just wrote: the fixer rewrites what it can (an import's line
   * breaks, a blank line, the final newline), and what it cannot goes back to the agent with the
   * write — the agent writes to the linter's rules as it goes, not a round of verify later.
   */
  private async fixWritten(
    rel: string,
    absolute: string,
    ctx: ToolContext,
  ): Promise<{ text: string; data?: { run: string[]; changed: boolean; clean: boolean } }> {
    const plans = rulesFor(this.config.tools.fix, [rel]);
    if (plans.length === 0) return { text: "" };
    const before = readFileSync(absolute, "utf8");
    const notes: string[] = [];
    let clean = true;
    for (const { run } of plans) {
      const command = this.config.tools.local[run];
      if (!command) {
        notes.push(`[fix "${run}": no tools.local command of that name]`);
        continue;
      }
      const out = await this.runProjectCommand(`${command} ${filesFor(command, [rel])}`, ctx);
      if (!out.ok) {
        clean = false;
        // its findings, not the command line and the exit footer
        const lines = (out.text ?? "")
          .split("\n")
          .slice(1, -1)
          .filter((l) => l.trim() !== "");
        notes.push(`[${run} found what it cannot fix — correct it:]\n${lines.slice(-30).join("\n")}`);
      }
    }
    const after = existsSync(absolute) ? readFileSync(absolute, "utf8") : before;
    const changed = after !== before;
    const region = changed ? reformatted(before, after) : undefined;
    const what = !changed
      ? "nothing to reformat"
      : region
        ? region.to < region.from
          ? "reformatted: lines removed, as below (the rest is as you wrote it)"
          : `reformatted lines ${region.from}–${region.to}, which now read as below (the rest is as you wrote it)`
        : "reformatted the file — read it again before the next edit";
    const head = `\n[${plans.map((p) => p.run).join(", ")}: ${what}${clean ? "; no problems left" : ""}]${region ? `\n${region.text}` : ""}`;
    return {
      text: `${head}${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`,
      data: { run: plans.map((p) => p.run), changed, clean },
    };
  }

  private inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
    const mine = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    this.queues.set(
      key,
      mine.catch(() => undefined),
    );
    return mine;
  }

  /** The state of a rebuild's sources in the checkout: the changed files it watches, with their times. */
  private async sourcesOf(name: string, ctx: ToolContext): Promise<string> {
    const rule = this.config.tools.rebuild.filter((r) => r.run === name).flatMap((r) => r.when);
    const base = ctx.run.workspace.baseCommit ?? ctx.run.workspace.baseRef;
    const changed = (await changedFiles(ctx.workspacePath, base)).filter((f) => globMatches(f, rule));
    return changed
      .map((f) => {
        try {
          return `${f}@${statSync(join(ctx.workspacePath, f)).mtimeMs}`;
        } catch {
          return `${f}@gone`;
        }
      })
      .join("\n");
  }

  private async markBuilt(name: string, ctx: ToolContext): Promise<void> {
    this.built.set(`${ctx.workspacePath}\0${name}`, await this.sourcesOf(name, ctx));
  }

  /** The rebuilds whose sources changed since they last ran here (never ran: the run changed them at all). */
  private async staleBuilds(ctx: ToolContext): Promise<string[]> {
    const names = [...new Set(this.config.tools.rebuild.map((r) => r.run))];
    const stale: string[] = [];
    for (const name of names) {
      const now = await this.sourcesOf(name, ctx);
      if (!now) continue;
      if (this.built.get(`${ctx.workspacePath}\0${name}`) !== now) stale.push(name);
    }
    return stale;
  }

  private async runProjectCommand(
    command: string,
    ctx: ToolContext,
    timeoutMs = this.config.tools.commandTimeoutMs,
  ): Promise<ToolOutput> {
    const r = await runShell(command, {
      cwd: ctx.workspacePath,
      timeoutMs,
      env: { ...ctx.env, CI: ctx.env.CI ?? "1", JARVIS_RUN: ctx.run.id },
    });
    const text = `$ ${command}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}\n[exit ${r.code ?? "killed"}${r.timedOut ? ", timed out" : ""} in ${r.durationMs} ms]`;
    return {
      ok: r.code === 0 && !r.timedOut,
      text,
      data: { code: r.code, timedOut: r.timedOut, durationMs: r.durationMs },
      ...(r.code !== 0 ? { error: `exit ${r.code ?? "killed"}` } : {}),
    };
  }
}

export { PathDeniedError };
export function workspaceFileExists(ctx: ToolContext, path: string): boolean {
  try {
    const { absolute } = resolveInWorkspace(ctx, path);
    return existsSync(absolute) && statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/** Lines the fixer may change and still be shown with the write's answer, instead of a read again. */
export const REFORMAT_SHOWN = 60;

/**
 * What a fixer changed, as the region's new text with its line numbers: the agent's next edit
 * matches it without reading the file again (pilot: every reformat cost a read and a model call).
 * The span from the first changed line to the last; past `REFORMAT_SHOWN` lines — undefined.
 */
export function reformatted(
  before: string,
  after: string,
): { from: number; to: number; text: string } | undefined {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const lines = b.slice(head, b.length - tail);
  if (lines.length > REFORMAT_SHOWN) return undefined;
  if (lines.length === 0) {
    const gone = a.length - head - tail;
    return {
      from: head + 1,
      to: head,
      text: `(${gone} line${gone > 1 ? "s" : ""} removed after line ${head})`,
    };
  }
  const from = head + 1;
  return {
    from,
    to: head + lines.length,
    text: lines.map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join("\n"),
  };
}

/**
 * The workspace's state as one hash: HEAD and every changed or new file's path, size and mtime.
 * Two git calls instead of a typecheck; undefined where git cannot say (nothing is cached then).
 */
export async function workspaceFingerprint(cwd: string): Promise<string | undefined> {
  const [head, status] = await Promise.all([
    git(["rev-parse", "HEAD"], cwd, { timeoutMs: 30_000 }),
    git(["status", "--porcelain=v1", "-z", "-uall"], cwd, { timeoutMs: 30_000 }),
  ]);
  if (head.code !== 0 || status.code !== 0) return undefined;
  const hash = createHash("sha256").update(head.stdout.trim());
  for (const entry of status.stdout.split("\0")) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    hash.update(`\0${entry}`);
    try {
      const st = statSync(join(cwd, path));
      hash.update(`:${st.size}:${st.mtimeMs}`);
    } catch {
      hash.update(":gone");
    }
  }
  return hash.digest("hex");
}
