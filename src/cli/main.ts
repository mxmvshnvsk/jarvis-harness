import { Command } from "commander";
import { ConfigError } from "../core/config/errors.ts";
import { packageInfo } from "../version.ts";
import { runConfigShow } from "./commands/config.ts";
import { runDbBackup, runDbMigrate, runDbStatus } from "./commands/db.ts";
import { renderDoctor, runDoctor } from "./commands/doctor.ts";
import { renderInit, runInit } from "./commands/init.ts";
import { runModelsList, runModelsProbe } from "./commands/models.ts";
import { runCancel, runStatus } from "./commands/status.ts";
import { type CliContext, defaultContext } from "./context.ts";
import { CliExit, createOutput, EXIT } from "./output.ts";

export interface RunOptions {
  readonly streams?: { out: NodeJS.WritableStream; err: NodeJS.WritableStream };
  readonly context?: Partial<CliContext>;
}

/** node:sqlite still prints an ExperimentalWarning; it is not actionable for users. */
function silenceSqliteWarning(): void {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
    for (const listener of listeners) listener(warning);
  });
}

export function buildProgram(options: RunOptions = {}): Command {
  const streams = options.streams ?? { out: process.stdout, err: process.stderr };
  const info = packageInfo();
  const program = new Command();
  program
    .name("jarvis")
    .description("Jarvis — durable AI engineering runtime")
    .version(info.version, "-V, --version")
    .option("--json", "machine-readable output", false)
    .option("--profile <name>", "apply a configuration profile (ADR-0009)")
    .option("--cwd <dir>", "run as if started in this directory")
    .showHelpAfterError();

  const ctxFor = (): CliContext => {
    const opts = program.opts<{ json: boolean; profile?: string; cwd?: string }>();
    const out = createOutput(opts.json, streams);
    const overrides: Partial<CliContext> = {
      ...options.context,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
    };
    return defaultContext(out, overrides);
  };

  program
    .command("init")
    .description("create ~/.jarvis and .jarvis/ with templates, initialise the database")
    .option("--user-only", "only set up ~/.jarvis")
    .option("--project-only", "only set up the project")
    .action(async (opts: { userOnly?: boolean; projectOnly?: boolean }) => {
      const ctx = ctxFor();
      const report = await runInit(ctx, opts);
      ctx.out.result(report, () => renderInit(ctx, report));
    });

  program
    .command("doctor")
    .description("check environment, configuration, database, secrets and egress policy")
    .action(async () => {
      const ctx = ctxFor();
      const report = await runDoctor(ctx);
      ctx.out.result(report, () => renderDoctor(ctx, report));
      if (ctx.out.json && !report.ok) throw new CliExit(EXIT.error);
    });

  const config = program.command("config").description("inspect configuration");
  config
    .command("show")
    .description("print the resolved configuration")
    .option("--sources", "show where every value comes from (ADR-0014 §2)")
    .action(async (opts: { sources?: boolean }) => {
      await runConfigShow(ctxFor(), opts);
    });

  program
    .command("status [run]")
    .description("active runs and budget, or one run in detail (ADR-0018 §1)")
    .option("--all", "include completed and cancelled runs")
    .option("--watch <seconds>", "refresh every N seconds", (v: string) => Number(v))
    .option("--events <n>", "number of recent events to show", (v: string) => Number(v))
    .action(async (run: string | undefined, opts: { all?: boolean; watch?: number; events?: number }) => {
      await runStatus(ctxFor(), run, opts);
    });

  program
    .command("cancel <run>")
    .description("cancel a run: immediately when idle, at the next safe point when executing (ADR-0002 §6)")
    .action(async (run: string) => {
      await runCancel(ctxFor(), run);
    });

  const models = program
    .command("models")
    .description("configured models and their probed capabilities (ADR-0007)");
  models
    .command("list")
    .description("models, egress, pools, window usage and probe state")
    .action(async () => {
      await runModelsList(ctxFor());
    });
  models
    .command("probe <modelId>")
    .description("send canary requests and record what the model supports")
    .action(async (modelId: string) => {
      await runModelsProbe(ctxFor(), modelId);
    });

  const db = program.command("db").description("local database");
  db.command("status")
    .description("schema version and pending migrations")
    .action(() => runDbStatus(ctxFor()));
  db.command("migrate")
    .description("apply pending migrations (backs up first)")
    .action(() => runDbMigrate(ctxFor()));
  db.command("backup")
    .description("write a backup next to the database")
    .action(() => runDbBackup(ctxFor()));

  return program;
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  silenceSqliteWarning();
  // `jarvis … | head` must not crash with EPIPE.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(EXIT.ok);
  });
  const streams = options.streams ?? { out: process.stdout, err: process.stderr };
  const program = buildProgram(options);
  program.exitOverride();
  program.configureOutput({
    writeOut: (s) => streams.out.write(s),
    writeErr: (s) => streams.err.write(s),
  });
  try {
    await program.parseAsync([...argv]);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliExit) return error.code;
    if (error instanceof ConfigError) {
      streams.err.write(`${error.message}\n`);
      return EXIT.error;
    }
    if (error && typeof error === "object" && "exitCode" in error && "code" in error) {
      // commander: help/version printed, or usage error
      const code = (error as { exitCode: number }).exitCode;
      return code;
    }
    streams.err.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return EXIT.error;
  }
}

export async function main(): Promise<void> {
  const code = await run(process.argv);
  process.exitCode = code;
}

if (process.argv[1] && /[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
