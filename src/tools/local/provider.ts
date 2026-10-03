import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ResolvedConfig } from "../../core/config/schema.ts";
import { readByRef } from "../../knowledge/resolver.ts";
import { refreshIndex, search } from "../../knowledge/retrieval/service.ts";
import { gitIdentityEnv } from "../../orchestration/worktree.ts";
import { effectMarker } from "../../storage/effects.ts";
import type { Capability, ToolContext, ToolOutput, ToolProvider } from "../types.ts";
import { git, hasRipgrep, runCommand, runShell } from "./exec.ts";
import { PathDeniedError, resolveInWorkspace } from "./paths.ts";

/**
 * Local tool provider (ADR-0001 §9): file system, search, git and project commands — all
 * confined to the workspace, all `network: none`.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".jarvis", "dist", "coverage", ".pnpm-store"]);

function fail(error: unknown): ToolOutput {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

  constructor(config: ResolvedConfig) {
    this.config = config;
  }

  capabilities(): readonly Capability[] {
    const caps: Capability[] = [
      {
        name: "repo.read",
        description: "Read a file inside the workspace. Optional 1-based startLine/endLine.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
          },
          required: ["path"],
        },
        handler: async (args, ctx) => {
          try {
            const { absolute, relative: rel } = resolveInWorkspace(ctx, str(args, "path"));
            const buffer = readFileSync(absolute);
            if (isProbablyBinary(buffer))
              return { ok: false, error: `${rel} is binary (${buffer.length} bytes)` };
            const lines = buffer.toString("utf8").split("\n");
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
          "Read in full by ref: a standard, skill or knowledge document listed as available on request (standard:ID@v, skill:id@v, knowledge:name), an artifact of this run (artifactId@version), or the original of trimmed/compacted context (blob:<ref>).",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: { ref: { type: "string", description: "e.g. standard:STD-CS-01@2" } },
          required: ["ref"],
        },
        handler: async (args, ctx) => {
          const ref = str(args, "ref");
          // Originals of trimmed/compacted context and earlier artifacts (ADR-0001 §7: sources survive summaries).
          if (ref.startsWith("blob:")) {
            const contentRef = ref.slice("blob:".length);
            return ctx.runtime.blobs.has(contentRef)
              ? { ok: true, text: ctx.runtime.blobs.getText(contentRef) }
              : { ok: false, error: `unknown blob "${contentRef}"` };
          }
          const artifactRef = /^([A-Za-z0-9_.:/-]+)@(\d+)$/.exec(ref);
          if (artifactRef && !/^(standard|skill|knowledge):/.test(ref)) {
            const artifact = ctx.runtime.artifacts.get(artifactRef[1] as string, Number(artifactRef[2]));
            if (artifact && artifact.runId === ctx.run.id)
              return { ok: true, text: ctx.runtime.artifacts.text(artifact) };
          }
          const text = readByRef(
            { projectRoot: ctx.workspacePath, userRoot: ctx.runtime.loaded.home.root },
            ref,
          );
          return text === undefined ? { ok: false, error: `unknown ref "${ref}"` } : { ok: true, text };
        },
      },
      {
        name: "knowledge.search",
        description:
          "Search project knowledge, standards, skills and this run's artifacts by meaning and words (FTS + glossary expansion); returns refs for knowledge.read.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "integer" } },
          required: ["query"],
        },
        handler: async (args, ctx) => {
          const roots = { projectRoot: ctx.workspacePath, userRoot: ctx.runtime.loaded.home.root };
          await refreshIndex(ctx.runtime, roots, ctx.run.id);
          const result = await search(ctx.runtime, roots, str(args, "query"), {
            limit: num(args, "limit", 10),
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
        description: "List files inside the workspace (tracked and untracked, ignoring .gitignore'd files).",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, maxEntries: { type: "integer" } },
        },
        handler: async (args, ctx) => {
          try {
            const { absolute, relative: rel } = resolveInWorkspace(ctx, str(args, "path", "."));
            const all = await listFiles(ctx, ctx.workspacePath);
            const prefix = rel === "." ? "" : `${rel}/`;
            const files = all.filter((f) => f.startsWith(prefix));
            const max = num(args, "maxEntries", 500);
            void absolute;
            return {
              ok: true,
              text: files.slice(0, max).join("\n"),
              data: { total: files.length, shown: Math.min(max, files.length) },
            };
          } catch (error) {
            return fail(error);
          }
        },
      },
      {
        name: "repo.search",
        description:
          "Search file contents (ripgrep when available). `pattern` is a regex unless literal=true.",
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
            const { absolute, relative: rel } = resolveInWorkspace(ctx, str(args, "path", "."));
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
              rgArgs.push("-e", pattern, ".");
              const r = await runCommand("rg", rgArgs, { cwd: absolute, timeoutMs: 60_000 });
              if (r.code !== 0 && r.code !== 1)
                return { ok: false, error: r.stderr || `rg exited ${r.code}` };
              const lines = r.stdout
                .split("\n")
                .filter((l) => l.length > 0)
                .map((l) => (rel === "." ? l.replace(/^\.\//, "") : `${rel}/${l.replace(/^\.\//, "")}`))
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
              (f) => rel === "." || f.startsWith(`${rel}/`),
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
        name: "repo.write",
        description: "Create or overwrite a file inside the workspace.",
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
            mkdirSync(dirname(absolute), { recursive: true });
            const content = str(args, "content");
            writeFileSync(absolute, content, "utf8");
            return {
              ok: true,
              text: `wrote ${rel} (${Buffer.byteLength(content)} bytes)`,
              data: { path: rel },
            };
          } catch (error) {
            return fail(error);
          }
        },
      },
      {
        name: "repo.edit",
        description:
          "Replace an exact text fragment in a file. Fails if the fragment is missing or ambiguous unless replaceAll=true.",
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
            const next =
              args.replaceAll === true
                ? current.split(oldText).join(newText)
                : current.replace(oldText, () => newText);
            writeFileSync(absolute, next, "utf8");
            return {
              ok: true,
              text: `edited ${rel} (${occurrences} replacement${occurrences > 1 ? "s" : ""})`,
              data: { path: rel, replacements: occurrences },
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
        description: "Diff of the workspace against a base (default: the run's base commit) or the index.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: { base: { type: "string" }, path: { type: "string" }, staged: { type: "boolean" } },
        },
        handler: async (args, ctx) => {
          const base = typeof args.base === "string" ? args.base : ctx.run.workspace.baseCommit;
          const gitArgs = ["diff", "--no-color"];
          if (args.staged === true) gitArgs.push("--cached");
          else if (base) gitArgs.push(base);
          if (typeof args.path === "string") gitArgs.push("--", resolveInWorkspace(ctx, args.path).relative);
          const r = await git(gitArgs, ctx.workspacePath);
          return r.code === 0 ? { ok: true, text: r.stdout } : { ok: false, error: r.stderr };
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

    for (const [name, command] of Object.entries(this.config.tools.local)) {
      caps.push({
        name: `project.${name}`,
        description: `Run the project's "${name}" command: ${command}`,
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: { args: { type: "string", description: "extra arguments appended to the command" } },
        },
        handler: async (args, ctx) =>
          this.runProjectCommand(`${command}${typeof args.args === "string" ? ` ${args.args}` : ""}`, ctx),
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
