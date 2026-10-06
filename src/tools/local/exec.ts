import { execFile, spawn } from "node:child_process";

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface CommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBytes?: number;
  readonly input?: string;
  /** Each non-empty output line as it comes (stdout and stderr), e.g. for a progress line. */
  readonly onLine?: (line: string) => void;
}

const DEFAULT_MAX = 8 * 1024 * 1024;

/** Runs an executable with arguments (no shell). Output is capped, never thrown away silently. */
export function runCommand(
  file: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const max = options.maxBytes ?? DEFAULT_MAX;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    const lines = (chunk: Buffer) => {
      if (!options.onLine) return;
      for (const line of chunk.toString("utf8").split(/\r?\n|\r/)) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
        const plain = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();
        if (plain) options.onLine(plain);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < max) stdout += chunk.toString("utf8");
      lines(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < max) stderr += chunk.toString("utf8");
      lines(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

/** Runs a command line through the shell (project commands, `shell.run`). */
export function runShell(command: string, options: CommandOptions): Promise<CommandResult> {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const flag = process.platform === "win32" ? "/c" : "-c";
  return runCommand(shell, [flag, command], options);
}

let rgAvailable: boolean | undefined;

export async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== undefined) return rgAvailable;
  rgAvailable = await new Promise<boolean>((resolve) => {
    execFile("rg", ["--version"], (error) => resolve(!error));
  });
  return rgAvailable;
}

export function git(
  args: readonly string[],
  cwd: string,
  options: Partial<CommandOptions> = {},
): Promise<CommandResult> {
  return runCommand("git", args, { cwd, timeoutMs: 120_000, ...options });
}
