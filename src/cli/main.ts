import { Command } from "commander";
import { ConfigError } from "../core/config/errors.ts";
import { errorFields } from "../telemetry/log.ts";
import { packageInfo } from "../version.ts";
import { cliLogger } from "./cliLog.ts";
import { runAsk } from "./commands/ask.ts";
import { runAuthRemove, runAuthSet, runAuthStatus } from "./commands/auth.ts";
import {
  runCandidatesList,
  runCandidatesPromote,
  runCandidatesReject,
  runCandidatesShow,
} from "./commands/candidates.ts";
import { runCi, runExport, runImport } from "./commands/ci.ts";
import { runConfigShow } from "./commands/config.ts";
import { runContext, runReshape } from "./commands/context.ts";
import { runDbBackup, runDbMigrate, runDbStatus } from "./commands/db.ts";
import { renderDoctor, runDoctor } from "./commands/doctor.ts";
import { runEvalsBaseline, runEvalsDiff, runEvalsRun, runEvalsRunToCase } from "./commands/evals.ts";
import { runExplain } from "./commands/explain.ts";
import { runHooksInstall, runHooksStatus, runHooksUninstall, runPrePush } from "./commands/hooks.ts";
import { runAnswer, runAttach, runReviewStatus, runReviewSubmit, runThreads } from "./commands/human.ts";
import { renderInit, runInit } from "./commands/init.ts";
import { runSkillsList, runStandardsCheck, runStandardsList } from "./commands/knowledge.ts";
import {
  runKnowledgeIndex,
  runKnowledgeSearch,
  runKnowledgeStatus,
  runKnowledgeUpdate,
} from "./commands/knowledgeGraph.ts";
import { runLogs } from "./commands/logs.ts";
import { runMcpList, runMcpServe } from "./commands/mcp.ts";
import { runModelsList, runModelsProbe } from "./commands/models.ts";
import { runOnboard } from "./commands/onboard.ts";
import { runApply, runApprove, runDaemon, runDiff, runGc, runResume, runWork } from "./commands/run.ts";
import { runCancel, runStatus } from "./commands/status.ts";
import { type CliContext, defaultContext } from "./context.ts";
import { CliExit, createOutput, EXIT } from "./output.ts";

export interface RunOptions {
  readonly streams?: { out: NodeJS.WritableStream; err: NodeJS.WritableStream };
  readonly stdin?: NodeJS.ReadableStream;
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
    const env = options.context?.env ?? process.env;
    const out = createOutput(opts.json, streams, { progress: env.JARVIS_PROGRESS !== "off" });
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
    .command("work <task>")
    .description("create a run for a task and execute it in the foreground (exit codes: ADR-0009 §3)")
    .option("--workflow <name>", "workflow definition to use", "sdd")
    .option("--base <ref>", "base ref for the run's worktree (default: HEAD)")
    .option("--no-run", "only create the run")
    .action(async (task: string, opts: { workflow: string; run: boolean; base?: string }) => {
      await runWork(ctxFor(), task, {
        workflow: opts.workflow,
        noRun: !opts.run,
        ...(opts.base ? { base: opts.base } : {}),
      });
    });

  program
    .command("research <task>")
    .description("run only the research step for a task (built-in workflow `research`)")
    .option("--base <ref>", "base ref for the run's worktree (default: HEAD)")
    .action(async (task: string, opts: { base?: string }) => {
      await runWork(ctxFor(), task, { workflow: "research", ...(opts.base ? { base: opts.base } : {}) });
    });
  program
    .command("spec <task>")
    .description("research, requirements and a specification up to its approval (built-in workflow `spec`)")
    .option("--base <ref>", "base ref for the run's worktree (default: HEAD)")
    .action(async (task: string, opts: { base?: string }) => {
      await runWork(ctxFor(), task, { workflow: "spec", ...(opts.base ? { base: opts.base } : {}) });
    });

  program
    .command("onboard")
    .description("scan the repository (no model): propose tools.local, write knowledge skeletons")
    .option("--dry-run", "show what would be written, write nothing", false)
    .option("--refresh", "regenerate files that still carry the generated marker", false)
    .option("--apply-config", "fill an empty tools.local in .jarvis/project.yaml", false)
    .option(
      "--module <path>",
      "agent mode: map one module with the onboard-mapper agent; the result waits as a knowledge candidate",
    )
    .option("--no-graph", "skip the project graph (module dependencies)")
    .action(
      async (opts: {
        dryRun: boolean;
        refresh: boolean;
        applyConfig: boolean;
        graph: boolean;
        module?: string;
      }) => {
        await runOnboard(ctxFor(), opts);
      },
    );
  program
    .command("logs [run]")
    .description(
      "technical log (NDJSON in ~/.jarvis/logs): errors, events, and with JARVIS_LOG=debug model and tool bodies",
    )
    .option("--level <level>", "error, info (default) or debug", "info")
    .option("--event <text>", "only events whose name contains this, e.g. model.error")
    .option("--tail <n>", "last n records", (v: string) => Number.parseInt(v, 10), 100)
    .option("--since <age>", "only records newer than 30m, 2h, 1d …")
    .option("--full", "do not shorten long values", false)
    .option("--path", "print the log directory", false)
    .action(
      async (
        run: string | undefined,
        opts: { level: string; event?: string; tail: number; since?: string; full: boolean; path: boolean },
      ) => {
        await runLogs(ctxFor(), run, opts);
      },
    );
  program
    .command("ask <question...>")
    .description(
      "reference desk: glossary terms and answers from the project knowledge base, with checked citations",
    )
    .option("--no-llm", "glossary and ranked sources only, no model")
    .option("--general", "also allow a clearly labelled note from the model's own knowledge", false)
    .option("--limit <n>", "max candidate sources", (v: string) => Number.parseInt(v, 10), 8)
    .action(async (question: string[], opts: { llm: boolean; general: boolean; limit: number }) => {
      await runAsk(ctxFor(), question, opts);
    });
  program
    .command("explain <target>")
    .description(
      "why a change exists: <file>[:line], a commit or a run → task, steps, artifacts, approvals, tools",
    )
    .action(async (target: string) => {
      await runExplain(ctxFor(), target);
    });
  program
    .command("diff <run>")
    .description("diff of a run's worktree against its base commit (ADR-0003 §4)")
    .action(async (run: string) => {
      await runDiff(ctxFor(), run);
    });

  program
    .command("apply <run>")
    .description("squash the run's branch onto the current branch of the main repository (ADR-0003 §4)")
    .option("--message <text>", "commit message")
    .action(async (run: string, opts: { message?: string }) => {
      await runApply(ctxFor(), run, opts);
    });

  program
    .command("gc")
    .description("remove worktrees of finished runs past retention (ADR-0003 §6)")
    .option("--prune-branches", "also delete the jarvis/* branches")
    .option("--days <n>", "retention in days (default: workspace.retentionDays)", (v: string) => Number(v))
    .action(async (opts: { pruneBranches?: boolean; days?: number }) => {
      await runGc(ctxFor(), opts);
    });

  program
    .command("resume <run>")
    .description("continue a parked, failed or crashed run from its last checkpoint")
    .option("--steal", "take the lease from a dead process (recorded in the audit trail)")
    .action(async (run: string, opts: { steal?: boolean }) => {
      await runResume(ctxFor(), run, opts);
    });

  program
    .command("approve <run>")
    .description("record a human decision on the artifact the run is waiting for (ADR-0005 §4)")
    .option("--type <artifactType>", "artifact type (defaults to what the run awaits)")
    .option("--reject", "reject instead of approve")
    .option("--request-changes", "ask for changes; goes back along the declared edge")
    .option("--comment <text>", "comment stored with the decision")
    .option("--resume", "continue the run right after recording the decision")
    .option("--commit", "also write .jarvis/approvals/<task>/<type>.json and commit it (ADR-0009 §4)")
    .action(
      async (
        run: string,
        opts: {
          type?: string;
          reject?: boolean;
          requestChanges?: boolean;
          comment?: string;
          resume?: boolean;
          commit?: boolean;
        },
      ) => {
        const decision = opts.reject ? "reject" : opts.requestChanges ? "request_changes" : "approve";
        await runApprove(ctxFor(), run, {
          ...(opts.type ? { type: opts.type } : {}),
          decision,
          ...(opts.comment ? { comment: opts.comment } : {}),
          ...(opts.resume ? { resume: true } : {}),
          ...(opts.commit ? { commit: true } : {}),
        });
      },
    );

  program
    .command("ci <task>")
    .description(
      "run a task under the `ci` profile: non-interactive, job summary, bundle on a human gate (ADR-0009)",
    )
    .option("--workflow <name>", "workflow definition to use", "sdd")
    .option("--summary <file>", "append the markdown summary here (default: $GITHUB_STEP_SUMMARY)")
    .option("--bundle <file>", "export the run as a bundle for `jarvis import`")
    .action(async (task: string, opts: { workflow: string; summary?: string; bundle?: string }) => {
      await runCi(ctxFor(), task, opts);
    });
  program
    .command("export <run>")
    .description(
      "write a run bundle: rows, artifacts, effects, threads and the workspace patch (ADR-0009 §5)",
    )
    .option("--out <file>", "bundle path (default: <run>.jarvis.json.gz)")
    .action(async (run: string, opts: { out?: string }) => {
      await runExport(ctxFor(), run, opts);
    });
  program
    .command("import <bundle>")
    .description("import a run bundle; rebuilds the worktree from the base commit with the patch applied")
    .action(async (file: string) => {
      await runImport(ctxFor(), file);
    });

  program
    .command("daemon")
    .description("resume parked runs when their budget window frees or their approval arrives")
    .option("--interval <seconds>", "seconds between ticks", (v: string) => Number(v), 30)
    .option("--once", "run a single tick and exit")
    .action(async (opts: { interval: number; once?: boolean }) => {
      await runDaemon(ctxFor(), opts);
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

  const mcp = program.command("mcp").description("MCP servers and their normalized capabilities (ADR-0017)");
  mcp
    .command("list")
    .description("servers, discovery state, exposed and denied capabilities")
    .option("--refresh", "connect to every server and refresh the tools cache", false)
    .action(async (opts: { refresh: boolean }) => {
      await runMcpList(ctxFor(), opts);
    });

  mcp
    .command("serve")
    .description(
      "serve Jarvis as a read-only MCP server on stdio: knowledge.search, spec.get, run.status, context.inspect",
    )
    .action(async () => {
      await runMcpServe(ctxFor());
    });

  const evals = program
    .command("evals")
    .description("workflow evals on fixture repositories with cassettes (ADR-0012)");
  evals
    .command("run")
    .requiredOption("--suite <name|dir>", "suite under evals/ or a directory")
    .option("--mode <mode>", "live | record | replay", "replay")
    .option("--variant <key=value...>", "configuration overrides applied to every case")
    .option("--out <file>", "result file (default: evals/results/<date>-<suite>.json)")
    .action(async (opts: { suite: string; mode: string; variant?: string[]; out?: string }) => {
      await runEvalsRun(ctxFor(), opts);
    });
  evals
    .command("run-to-case <run>")
    .description(
      "turn a finished run into an eval case: fixture at the base commit, gold from what the human accepted",
    )
    .requiredOption("--suite <name|dir>", "suite to add the case to")
    .option("--id <id>", "case id (default: from the task key)")
    .option("--no-fixture", "write case.yaml only")
    .action(async (ref: string, opts: { suite: string; id?: string; fixture: boolean }) => {
      await runEvalsRunToCase(ctxFor(), ref, {
        suite: opts.suite,
        ...(opts.id ? { id: opts.id } : {}),
        fixture: opts.fixture,
      });
    });
  evals
    .command("baseline <suite>")
    .description("pin the latest result of the suite as its baseline")
    .option("--from <file>", "use this result file instead of the latest")
    .action(async (suite: string, opts: { from?: string }) => {
      await runEvalsBaseline(ctxFor(), suite, opts);
    });
  evals
    .command("diff <suite>")
    .description("compare the latest result with the baseline; non-zero on regression beyond tolerance")
    .option("--tolerance <ratio>", "allowed relative drop", Number.parseFloat, 0.05)
    .option("--from <file>", "compare this result file instead of the latest")
    .action(async (suite: string, opts: { tolerance: number; from?: string }) => {
      await runEvalsDiff(ctxFor(), suite, opts);
    });

  const auth = program.command("auth").description("credentials in the OS keychain (ADR-0017 §5)");
  auth
    .command("set <id>")
    .description("store a credential for keychain:<id> (prompted without echo, or piped on stdin)")
    .action(async (id: string) => {
      await runAuthSet(ctxFor(), id, options.stdin ?? process.stdin);
    });
  auth
    .command("status")
    .description("which referenced credentials are set (values are never shown)")
    .action(async () => {
      await runAuthStatus(ctxFor());
    });
  auth
    .command("remove <id>")
    .description("delete a credential")
    .action(async (id: string) => {
      await runAuthRemove(ctxFor(), id);
    });

  program
    .command("context [run]")
    .description("the agent's context of a run now: window, base, history, pressure level (ADR-0013)")
    .action(async (ref: string | undefined) => {
      await runContext(ctxFor(), ref);
    });
  program
    .command("compact <run>")
    .description("trim old tool results and compact older history into a handoff; the next resume uses it")
    .option("--aggressive", "keep less history", false)
    .option("--dry-run", "show the plan without changing anything or calling a model", false)
    .action(async (ref: string, opts: { aggressive: boolean; dryRun: boolean }) => {
      await runReshape(ctxFor(), ref, opts, false);
    });
  program
    .command("reset-context <run>")
    .description("replace the agent's history with a structured handoff (a fresh window); originals are kept")
    .option("--dry-run", "show the plan without changing anything or calling a model", false)
    .action(async (ref: string, opts: { dryRun: boolean }) => {
      await runReshape(ctxFor(), ref, opts, true);
    });
  const hooks = program.command("hooks").description("git hooks (ADR-0001 §16)");
  hooks
    .command("install")
    .description("install the pre-push hook: standards, project checks, graph impact, review when warranted")
    .option("--force", "back up and replace a pre-push hook jarvis did not write", false)
    .action(async (opts: { force: boolean }) => {
      await runHooksInstall(ctxFor(), opts);
    });
  hooks
    .command("uninstall")
    .description("remove the pre-push hook (restores the one it replaced)")
    .action(async () => {
      await runHooksUninstall(ctxFor());
    });
  hooks
    .command("status")
    .description("is the hook installed, and the hooks.prePush policy in force")
    .action(async () => {
      await runHooksStatus(ctxFor());
    });
  program
    .command("prepush [remote] [url]")
    .description("checks before a push: standards, project checks, graph impact, review when warranted")
    .option("--hook", "read the pushed refs from stdin, as git passes them to the hook", false)
    .option("--base <ref>", "compare against this ref (default: upstream or trunk)")
    .option("--head <ref>", "the tip to check", "HEAD")
    .option("--semantic", "always run the semantic review")
    .option("--no-semantic", "never run the semantic review")
    .action(
      async (
        remote: string | undefined,
        _url: string | undefined,
        opts: { hook: boolean; base?: string; head: string; semantic?: boolean },
      ) => {
        await runPrePush(ctxFor(), {
          hook: opts.hook,
          ...(opts.base ? { base: opts.base } : {}),
          head: opts.head,
          ...(opts.semantic === undefined ? {} : { semantic: opts.semantic }),
          ...(remote ? { remote } : {}),
        });
      },
    );
  program
    .command("threads")
    .description("open human threads: clarifications, reviews, approvals (ADR-0019)")
    .option("--all", "include resolved and rejected threads", false)
    .action(async (opts: { all: boolean }) => {
      await runThreads(ctxFor(), opts);
    });
  program
    .command("answer <threadOrRun> [text]")
    .description("answer a clarification thread asynchronously; --accept takes the proposed rule")
    .option("--accept", "accept the proposed resolution (or --rule)", false)
    .option("--reject", "reject the thread; the run keeps waiting", false)
    .option("--rule <text>", "accept with this rule instead of the proposal")
    .option("--resume", "continue the run after a resolution", false)
    .action(
      async (
        ref: string,
        text: string | undefined,
        opts: { accept: boolean; reject: boolean; rule?: string; resume: boolean },
      ) => {
        await runAnswer(ctxFor(), ref, text, opts);
      },
    );
  program
    .command("attach <run>")
    .description("live mode: the open thread as a terminal mini-chat; resumes the run after a resolution")
    .option("--no-resume", "detach after the resolution instead of resuming")
    .action(async (ref: string, opts: { resume: boolean }) => {
      await runAttach(ctxFor(), ref, options.stdin ?? process.stdin, { noResume: !opts.resume });
    });
  const review = program
    .command("review")
    .description("Review Mode: REVIEW markers in the code become a review package (ADR-0019 §5)");
  review
    .command("submit [run]")
    .description(
      "collect `// REVIEW:` markers from the run's workspace and route the gate to review analysis",
    )
    .option("--resume", "continue the run right away", false)
    .action(async (ref: string | undefined, opts: { resume: boolean }) => {
      await runReviewSubmit(ctxFor(), ref, opts);
    });

  const knowledge = program.command("knowledge").description("project graph (ADR-0008)");
  knowledge
    .command("update")
    .description("incremental graph update: facts from the blob cache, edges per tree")
    .option("--full", "ignore the cache and rebuild", false)
    .action(async (opts: { full: boolean }) => {
      await runKnowledgeUpdate(ctxFor(), opts);
    });
  knowledge
    .command("index")
    .description(
      "index knowledge, standards and skills for search (FTS5; vectors when knowledge.retrieval.embeddings is set)",
    )
    .action(async () => {
      await runKnowledgeIndex(ctxFor());
    });
  knowledge
    .command("search <query>")
    .description("search the index with glossary expansion, as agents do")
    .option("--limit <n>", "max hits", (v: string) => Number.parseInt(v, 10), 10)
    .action(async (query: string, opts: { limit: number }) => {
      await runKnowledgeSearch(ctxFor(), query, opts);
    });
  knowledge
    .command("status")
    .description("latest snapshot; --verify recomputes without the cache and compares")
    .option("--verify", "determinism check", false)
    .action(async (opts: { verify: boolean }) => {
      await runKnowledgeStatus(ctxFor(), opts);
    });

  review
    .command("status [run]")
    .description("every review comment of the run with its lifecycle state")
    .action(async (ref: string | undefined) => {
      await runReviewStatus(ctxFor(), ref);
    });

  const standards = program.command("standards").description("project standards (ADR-0020)");
  standards
    .command("list")
    .description("standards with scope, severity and verification kind")
    .action(async () => {
      await runStandardsList(ctxFor());
    });
  standards
    .command("check")
    .description("run the deterministic checks against the files changed since --base")
    .option("--base <ref>", "git ref to diff against", "HEAD")
    .action(async (opts: { base: string }) => {
      await runStandardsCheck(ctxFor(), opts);
    });

  const skills = program.command("skills").description("skills (ADR-0020)");
  skills
    .command("list")
    .description("built-in, project and user skills; which ones a generic change would select")
    .option("--agent <id>", "resolve for this agent", "implementation")
    .action(async (opts: { agent: string }) => {
      await runSkillsList(ctxFor(), opts);
    });

  const candidates = program
    .command("candidates")
    .description("knowledge candidates from reviews (ADR-0020 §6)");
  candidates
    .command("list")
    .description("open candidates by name, with where to look and what to check")
    .option("--all", "include decided candidates", false)
    .action(async (opts: { all: boolean }) => {
      await runCandidatesList(ctxFor(), opts);
    });
  candidates
    .command("show <name>")
    .description("the document as promote would write it, with the claims to check first")
    .action(async (name: string) => {
      await runCandidatesShow(ctxFor(), name);
    });
  candidates
    .command("promote <name>")
    .description("write the candidate as a standard / knowledge file and record the decision")
    .option("--id <id>", "file id (default: derived from the name)")
    .action(async (name: string, opts: { id?: string }) => {
      await runCandidatesPromote(ctxFor(), name, opts);
    });
  candidates
    .command("reject <name>")
    .option("--comment <text>")
    .action(async (name: string, opts: { comment?: string }) => {
      await runCandidatesReject(ctxFor(), name, opts);
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
  const log = cliLogger(options.context);
  const started = Date.now();
  log.info("cli.invoke", {
    args: argv.slice(2),
    cwd: options.context?.cwd ?? process.cwd(),
    pid: process.pid,
  });
  try {
    await program.parseAsync([...argv]);
    log.info("cli.exit", { code: EXIT.ok, ms: Date.now() - started });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliExit) {
      log.info("cli.exit", { code: error.code, ms: Date.now() - started });
      return error.code;
    }
    if (error instanceof ConfigError) {
      log.error("cli.error", { message: error.message, ms: Date.now() - started });
      streams.err.write(`${error.message}\n`);
      return EXIT.error;
    }
    if (error && typeof error === "object" && "exitCode" in error && "code" in error) {
      // commander: help/version printed, or usage error
      const code = (error as { exitCode: number }).exitCode;
      return code;
    }
    log.error("cli.crash", { ...errorFields(error), ms: Date.now() - started });
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
