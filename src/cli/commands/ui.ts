import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createEngine } from "../../app/engine.ts";
import { createRuntime } from "../../app/runtime.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import { startUiServer, type UiServer } from "../../ui/server.ts";
import { systemOpener } from "../checkout.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";

/** Opens an address in the person's browser without waiting; false when there is no opener. */
export type BrowserOpener = (url: string) => boolean;

/**
 * `$BROWSER`, else the system's opener: `open` (macOS), `start` (Windows), `xdg-open` — the same
 * kind of opener as `o` uses for a checkout (src/cli/checkout.ts).
 */
export function systemBrowser(ctx: CliContext): BrowserOpener {
  return (url) => {
    const env = ctx.env ?? {};
    const own = env.BROWSER?.trim();
    const onPath = (c: string) =>
      (env.PATH ?? "").split(delimiter).some((d) => d.length > 0 && existsSync(join(d, c)));
    const command: string[] | undefined = own
      ? [...own.split(/\s+/), url]
      : process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : onPath("xdg-open")
            ? ["xdg-open", url]
            : undefined;
    if (!command) return false;
    try {
      const child = spawn(command[0] as string, command.slice(1), {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...env },
      });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  };
}

export interface UiOptions {
  readonly port?: number;
  /** true/false: open the browser or not; undefined: when a person is at the terminal. */
  readonly open?: boolean;
  /** For tests: called once the server listens; the command returns when the promise settles. */
  readonly until?: (server: UiServer) => Promise<void>;
  readonly browser?: BrowserOpener;
}

/**
 * `jarvis ui [--port N] [--open | --no-open]` — the runs of this machine on a local page
 * (ADR-0023 §3): what waits for you, what runs, what finished; a run's steps, card and activity; a
 * document with the run's diff. Ctrl-C stops it; the runs are not touched.
 */
export async function runUi(ctx: CliContext, options: UiOptions = {}): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  const st = ctx.out.style;
  let server: UiServer | undefined;
  try {
    const engine = createEngine(runtime);
    const base = {
      runtime,
      engine,
      homeDir: ctx.homeDir,
      ...(loaded.project?.root ? { projectRoot: loaded.project.root } : {}),
      // decisions on the page are the CLI's, with its actor (ADR-0006); `channel: ui` tells them apart
      actor: async () => (await resolveActor(loaded.config, ctx.env, loaded.project?.root)).actor,
      open: systemOpener(ctx),
    };
    const wanted = options.port ?? 4317;
    try {
      server = await startUiServer({ ...base, port: wanted });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || options.port !== undefined) {
        ctx.out.error(
          code === "EADDRINUSE"
            ? `port ${wanted} is taken — pick another with --port, or 0 for any free one`
            : String((error as Error).message),
        );
        throw new CliExit(EXIT.error);
      }
      server = await startUiServer({ ...base, port: 0 }); // the usual port is taken: any free one
    }
    const tty = (process.stdout as { isTTY?: boolean }).isTTY === true && !ctx.out.json;
    const open = options.open ?? tty;
    const opened = open ? (options.browser ?? systemBrowser(ctx))(server.url) : false;
    ctx.out.result({ url: server.url, port: server.port }, () => {
      ctx.out.line(`${st.ok("●")} jarvis ui  ${st.link(server?.url ?? "", server?.url ?? "")}`);
      ctx.out.line(
        st.muted(
          `  ${opened ? "opened in your browser · " : ""}only this machine (127.0.0.1); the address carries the session token · Ctrl-C stops`,
        ),
      );
    });
    if (options.until) {
      await options.until(server);
      return;
    }
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    ctx.out.line(st.muted("stopped"));
  } finally {
    await server?.close();
    await runtime.close();
  }
}
