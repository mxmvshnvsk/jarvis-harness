import { Command, InvalidArgumentError } from "commander";
import { ConfigError } from "../core/config/errors.ts";
import {
  type FreshSource,
  FreshSourceSchema,
  TASK_KINDS,
  type TaskKind,
  TaskKindSchema,
} from "../core/domain/run.ts";
import { errorFields } from "../telemetry/log.ts";
import { staleBuild, versionText } from "../version.ts";
import { cliLogger } from "./cliLog.ts";
import { runAsk } from "./commands/ask.ts";
import { runAuthRemove, runAuthSet, runAuthStatus } from "./commands/auth.ts";
import {
  runCandidatesAdd,
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
import { renderSecurityReport, runSecurityReport } from "./commands/doctorSecurity.ts";
import { runEffect } from "./commands/effect.ts";
import {
  runEvalsBaseline,
  runEvalsCandidates,
  runEvalsDiff,
  runEvalsRun,
  runEvalsRunToCase,
  runEvalsSchedule,
} from "./commands/evals.ts";
import { runExplain } from "./commands/explain.ts";
import { runHooksInstall, runHooksStatus, runHooksUninstall, runPrePush } from "./commands/hooks.ts";
import { runAnswer, runAttach, runReviewStatus, runReviewSubmit, runThreads } from "./commands/human.ts";
import { renderInit, runInit } from "./commands/init.ts";
import { renderInitKnowledge, runInitKnowledge } from "./commands/initKnowledge.ts";
import { runSkillsList, runStandardsCheck, runStandardsList } from "./commands/knowledge.ts";
import {
  runKnowledgeIndex,
  runKnowledgeSearch,
  runKnowledgeStatus,
  runKnowledgeUpdate,
} from "./commands/knowledgeGraph.ts";
import { runKnowledgeLinks } from "./commands/links.ts";
import { runLogs } from "./commands/logs.ts";
import { runMcpCall, runMcpList, runMcpServe } from "./commands/mcp.ts";
import { runModelsList, runModelsProbe, runModelsStats } from "./commands/models.ts";
import { runOnboard } from "./commands/onboard.ts";
import { runKnowledgeEval } from "./commands/retrievalEval.ts";
import {
  runApply,
  runApprove,
  runContinue,
  runDaemon,
  runDiff,
  runEdit,
  runFollow,
  runForget,
  runGc,
  runOpen,
  runRedo,
  runRestart,
  runResume,
  runShellIn,
  runShow,
  runWork,
} from "./commands/run.ts";
import { runScope } from "./commands/scope.ts";
import { runCancel, runStatus } from "./commands/status.ts";
import {
  runSubtaskContract,
  runSubtaskDrop,
  runSubtaskList,
  runSubtaskPublish,
  runSubtaskRetry,
  runSubtaskRun,
  runSubtaskStart,
} from "./commands/subtask.ts";
import { runUi } from "./commands/ui.ts";
import { type CliContext, defaultContext } from "./context.ts";
import { DIAGNOSES } from "./diagnostics.ts";
import { CliExit, createOutput, EXIT } from "./output.ts";

export interface RunOptions {
  readonly streams?: { out: NodeJS.WritableStream; err: NodeJS.WritableStream };
  readonly stdin?: NodeJS.ReadableStream;
  readonly context?: Partial<CliContext>;
}

/** node:sqlite still prints an ExperimentalWarning; it is not actionable for users. */
const FRESH_HELP =
  'read these sources again, past Jarvis\'s cache: "design" — the Figma frames (changed at the same link); each read spends a Figma API call';

/** `--fresh design`: the sources a run reads again past the cache. */
function parseFresh(value: string): FreshSource[] {
  const asked = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const parsed = asked.map((v) => FreshSourceSchema.safeParse(v));
  const bad = asked.filter((_, i) => !parsed[i]?.success);
  if (bad.length > 0 || asked.length === 0)
    throw new InvalidArgumentError(
      `expected ${FreshSourceSchema.options.join(", ")}; got ${bad.join(", ") || "nothing"}`,
    );
  return [...new Set(asked as FreshSource[])];
}

const KIND_HELP = `the kind of task, for the skills and standards scoped by kind: ${TASK_KINDS.join(", ")} (default: the workflow's, else change)`;

/** `--kind fix`: what kind of work the task is (ADR-0020 §1). */
function parseKind(value: string): TaskKind {
  const parsed = TaskKindSchema.safeParse(value.trim());
  if (!parsed.success) throw new InvalidArgumentError(`expected ${TASK_KINDS.join(", ")}; got ${value}`);
  return parsed.data;
}

const AUTONOMOUS_HELP =
  "experimental: no person in the loop — gates pass, a question gets the most cautious assumption, a dead end ends the run (human.autonomous)";
const DELIVER_HELP =
  'when the workflow is done: "pr" — push the branch and open the pull request without waiting for you (delivery.pr applies)';

/** `--deliver pr`: the run delivers itself when done (ADR-0003 §4). */
function parseDeliver(value: string): "pr" {
  if (value.trim() !== "pr") throw new InvalidArgumentError(`expected pr; got ${value}`);
  return "pr";
}

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
  const program = new Command();
  program
    .name("jarvis")
    .description("Jarvis — durable AI engineering runtime")
    .version(versionText(), "-V, --version")
    .option("--json", "machine-readable output", false)
    .option("--profile <name>", "apply a configuration profile (ADR-0009)")
    .option("--cwd <dir>", "run as if started in this directory")
    .option("--color", "colour the output even when it is not a terminal")
    .option("--no-color", "plain output (also NO_COLOR=1)")
    .option(
      "--progress <mode>",
      "how a run's course is shown on stderr: auto, tty (redrawn), plain (lines and a heartbeat), json (events)",
    )
    .showHelpAfterError();

  const ctxFor = (): CliContext => {
    const opts = program.opts<{
      json: boolean;
      profile?: string;
      cwd?: string;
      color?: boolean;
      progress?: string;
    }>();
    const env = options.context?.env ?? process.env;
    const setting = opts.progress ?? env.JARVIS_PROGRESS;
    const out = createOutput(opts.json, streams, {
      ...(setting ? { progressSetting: setting } : {}),
      accessible: /^(1|on|true|yes)$/i.test(env.JARVIS_ACCESSIBLE ?? ""),
      env,
      ...(opts.color !== undefined ? { color: opts.color } : {}),
    });
    const overrides: Partial<CliContext> = {
      stdin: options.stdin ?? process.stdin,
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
    .option(
      "--knowledge",
      "make this folder a knowledge repository of many services: project.yaml at its top, a map of the git repositories next to it (ADR-0025)",
    )
    .option("--repos <dir>", "with --knowledge: where the services' repositories lie (default ..)")
    .action(
      async (opts: { userOnly?: boolean; projectOnly?: boolean; knowledge?: boolean; repos?: string }) => {
        const ctx = ctxFor();
        if (opts.knowledge) {
          const report = await runInitKnowledge(ctx, {
            ...(opts.repos ? { repos: opts.repos } : {}),
            ...(opts.projectOnly ? { projectOnly: true } : {}),
          });
          ctx.out.result(report, () => renderInitKnowledge(ctx, report));
          return;
        }
        const report = await runInit(ctx, opts);
        ctx.out.result(report, () => renderInit(ctx, report));
      },
    );

  program
    .command("doctor")
    .description("check environment, configuration, database, secrets and egress policy")
    .option(
      "--security",
      "only security: redactions, egress by model and MCP server, exceptions, secrets, denied paths (ADR-0010)",
    )
    .action(async (opts: { security?: boolean }) => {
      const ctx = ctxFor();
      if (opts.security) {
        const security = await runSecurityReport(ctx);
        ctx.out.result(security, () => renderSecurityReport(ctx, security));
        if (ctx.out.json && !security.ok) throw new CliExit(EXIT.error);
        return;
      }
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
    .option("--fresh <sources>", FRESH_HELP, parseFresh)
    .option("--kind <kind>", KIND_HELP, parseKind)
    .option("--autonomous", AUTONOMOUS_HELP)
    .option("--deliver <how>", DELIVER_HELP, parseDeliver)
    .action(
      async (
        task: string,
        opts: {
          workflow: string;
          run: boolean;
          base?: string;
          fresh?: FreshSource[];
          kind?: TaskKind;
          deliver?: "pr";
          autonomous?: boolean;
        },
      ) => {
        await runWork(ctxFor(), task, {
          workflow: opts.workflow,
          noRun: !opts.run,
          ...(opts.base ? { base: opts.base } : {}),
          ...(opts.fresh ? { fresh: opts.fresh } : {}),
          ...(opts.kind ? { kind: opts.kind } : {}),
          ...(opts.deliver ? { deliver: opts.deliver } : {}),
          ...(opts.autonomous ? { autonomous: true } : {}),
        });
      },
    );

  program
    .command("research <task>")
    .description("run only the research step for a task (built-in workflow `research`)")
    .option("--base <ref>", "base ref for the run's worktree (default: HEAD)")
    .option("--fresh <sources>", FRESH_HELP, parseFresh)
    .option("--kind <kind>", KIND_HELP, parseKind)
    .option("--autonomous", AUTONOMOUS_HELP)
    .action(
      async (
        task: string,
        opts: { base?: string; fresh?: FreshSource[]; kind?: TaskKind; autonomous?: boolean },
      ) => {
        await runWork(ctxFor(), task, {
          workflow: "research",
          ...(opts.autonomous ? { autonomous: true } : {}),
          ...(opts.base ? { base: opts.base } : {}),
          ...(opts.fresh ? { fresh: opts.fresh } : {}),
          ...(opts.kind ? { kind: opts.kind } : {}),
        });
      },
    );
  program
    .command("fix <task>")
    .description(
      "a bug fix, the short way: research, a spec to approve, the change with its test, the project's checks, review (built-in workflow `fix`)",
    )
    .option("--base <ref>", "base ref for the run's worktree (default: HEAD)")
    .option("--fresh <sources>", FRESH_HELP, parseFresh)
    .option("--kind <kind>", KIND_HELP, parseKind)
    .option("--autonomous", AUTONOMOUS_HELP)
    .action(
      async (
        task: string,
        opts: { base?: string; fresh?: FreshSource[]; kind?: TaskKind; autonomous?: boolean },
      ) => {
        await runWork(ctxFor(), task, {
          workflow: "fix",
          ...(opts.autonomous ? { autonomous: true } : {}),
          ...(opts.base ? { base: opts.base } : {}),
          ...(opts.fresh ? { fresh: opts.fresh } : {}),
          ...(opts.kind ? { kind: opts.kind } : {}),
        });
      },
    );
  program
    .command("spec <task>")
    .description("research, requirements and a specification up to its approval (built-in workflow `spec`)")
    .option("--base <ref>", "base ref for the run's worktree (default: HEAD)")
    .option("--fresh <sources>", FRESH_HELP, parseFresh)
    .option("--kind <kind>", KIND_HELP, parseKind)
    .option("--autonomous", AUTONOMOUS_HELP)
    .action(
      async (
        task: string,
        opts: { base?: string; fresh?: FreshSource[]; kind?: TaskKind; autonomous?: boolean },
      ) => {
        await runWork(ctxFor(), task, {
          workflow: "spec",
          ...(opts.autonomous ? { autonomous: true } : {}),
          ...(opts.base ? { base: opts.base } : {}),
          ...(opts.fresh ? { fresh: opts.fresh } : {}),
          ...(opts.kind ? { kind: opts.kind } : {}),
        });
      },
    );

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
    .option("--note <text>", "with --module: what matters, added to the agent's task")
    .option("--no-graph", "skip the project graph (module dependencies)")
    .option(
      "--service <name>",
      "in a knowledge repository: only this service (without it: every service of the map, each in its repository)",
    )
    .action(
      async (opts: {
        dryRun: boolean;
        refresh: boolean;
        applyConfig: boolean;
        graph: boolean;
        module?: string;
        note?: string;
        service?: string;
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
    .option("-f, --follow", "keep printing new records (Ctrl-C stops)", false)
    .action(
      async (
        run: string | undefined,
        opts: {
          level: string;
          event?: string;
          tail: number;
          since?: string;
          full: boolean;
          path: boolean;
          follow: boolean;
        },
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
    .command("errors [code]")
    .description("what an error code means and what to do: J001 … (no code: the list)")
    .action((code: string | undefined) => {
      const ctx = ctxFor();
      const st = ctx.out.style;
      const list = code ? DIAGNOSES.filter((d) => d.code.toLowerCase() === code.toLowerCase()) : DIAGNOSES;
      if (code && list.length === 0) {
        ctx.out.error(`no error code ${code} (\`jarvis errors\` lists them)`);
        throw new CliExit(EXIT.error);
      }
      ctx.out.result(
        list.map(({ match: _m, ...d }) => d),
        () => {
          for (const d of list) {
            ctx.out.line(`${st.bad(d.code)}  ${st.heading(d.title)}`);
            if (code) {
              ctx.out.line(`  ${d.explain}`);
              ctx.out.line(`  ${st.muted("help:")} ${d.help}`);
            }
          }
        },
      );
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
    .command("show <run> [artifact]")
    .description("what a run produced: the list, or one artifact (type, name or a unique part) to read")
    .option("--out <file>", "write the artifact to a file instead of printing it")
    .option("--raw", "print a JSON document as it is stored, not as markdown")
    .action(async (run: string, artifact: string | undefined, opts: { out?: string; raw?: boolean }) => {
      await runShow(ctxFor(), run, artifact, {
        ...(opts.out ? { out: opts.out } : {}),
        ...(opts.raw ? { raw: true } : {}),
      });
    });
  program
    .command("diff <run>")
    .description("diff of a run's worktree against its base commit (ADR-0003 §4)")
    .action(async (run: string) => {
      await runDiff(ctxFor(), run);
    });

  program
    .command("apply <run>")
    .description(
      "squash the run's branch onto the current branch of the main repository, or with --pr push it and open a pull request (ADR-0003 §4)",
    )
    .option("--message <text>", "commit message")
    .option("--pr", "push the run's branch and open a pull request through the MCP server instead")
    .option("--title <text>", "the PR's title (default: the spec's, else the task)")
    .option(
      "--target <branch>",
      "the branch the PR goes into (default: delivery.target, else the remote's default)",
    )
    .option("-y, --yes", "delivery.pr: approve — approve the PR as shown without asking")
    .action(
      async (
        run: string,
        opts: { message?: string; pr?: boolean; title?: string; target?: string; yes?: boolean },
      ) => {
        await runApply(ctxFor(), run, opts);
      },
    );

  program
    .command("gc")
    .description("remove worktrees of finished runs past retention (ADR-0003 §6)")
    .option("--prune-branches", "also delete the jarvis/* branches")
    .option("--days <n>", "retention in days (default: workspace.retentionDays)", (v: string) => Number(v))
    .action(async (opts: { pruneBranches?: boolean; days?: number }) => {
      await runGc(ctxFor(), opts);
    });

  program
    .command("continue [run]")
    .alias("c")
    .description("back to the run that waits for you (no id needed): decide right here and go on")
    .action(async (run: string | undefined) => {
      await runContinue(ctxFor(), run);
    });
  program
    .command("restart <run>")
    .description(
      "a stopped run (cancelled, failed, finished) again from one of its steps, with what it did before it",
    )
    .option("--from <step>", "the step to start at (default: right after the last approval)")
    .option("--note <text>", "for the first step: what to do differently")
    .option("--no-run", "create the run, do not start it")
    .action(async (run: string, opts: { from?: string; note?: string; run: boolean }) => {
      await runRestart(ctxFor(), run, {
        ...(opts.from ? { from: opts.from } : {}),
        ...(opts.note ? { note: opts.note } : {}),
        noRun: !opts.run,
      });
    });
  program
    .command("redo <run> <step>")
    .description(
      "back to a step the run went through, with a note for it; the steps after it run again (an ended run: a new one from the step)",
    )
    .option("--note <text>", "what the step should do differently")
    .option("--no-run", "record it, do not go on now")
    .action(async (run: string, step: string, opts: { note?: string; run: boolean }) => {
      await runRedo(ctxFor(), run, step, { ...(opts.note ? { note: opts.note } : {}), noRun: !opts.run });
    });
  program
    .command("forget [runs...]")
    .description(
      "finished runs leave Jarvis's store: record, events, artifacts, checkouts (cannot be undone)",
    )
    .option("--all", "every finished run of this repository")
    .option("-y, --yes", "do not ask")
    .action(async (runs: string[], opts: { all?: boolean; yes?: boolean }) => {
      await runForget(ctxFor(), runs, opts);
    });
  program
    .command("open [run]")
    .description("the run's checkout in your editor (JARVIS_EDITOR, else code, webstorm, idea…)")
    .action(async (run: string | undefined) => {
      await runOpen(ctxFor(), run);
    });
  program
    .command("ui")
    .description("the runs on a local page: what waits for you, what runs, documents and diffs (127.0.0.1)")
    .option("--port <n>", "port to listen on (default 4317; 0 picks a free one)", (v: string) => Number(v))
    .option("--open", "open the page in your browser (default at a terminal)")
    .option("--no-open", "only print the address")
    .action(async (opts: { port?: number; open?: boolean }) => {
      await runUi(ctxFor(), {
        ...(opts.port !== undefined && Number.isInteger(opts.port) && opts.port >= 0
          ? { port: opts.port }
          : {}),
        ...(opts.open !== undefined ? { open: opts.open } : {}),
      });
    });
  program
    .command("shell [run]")
    .description(
      "a shell in the run's checkout, to fix something by hand (newest unfinished run here by default)",
    )
    .option("--print", 'print the checkout\'s path instead, for cd "$(jarvis shell --print)"')
    .action(async (run: string | undefined, opts: { print?: boolean }) => {
      await runShellIn(ctxFor(), run, opts);
    });
  program
    .command("follow [run]")
    .description("follow a run that goes on elsewhere (another terminal, the daemon); Ctrl-C only detaches")
    .action(async (run: string | undefined) => {
      await runFollow(ctxFor(), run);
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
    .command("edit <run> [type]")
    .description(
      "edit a run's document (spec, plan, review) as a file in $EDITOR; the change becomes its next version (ADR-0005 §3)",
    )
    .option("--no-open", "only print the file's path")
    .action(async (run: string, type: string | undefined, opts: { open: boolean }) => {
      await runEdit(ctxFor(), run, type, { open: opts.open });
    });

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
    .command("effect <run>")
    .description(
      "a run waits on an effect whose outcome is unknown: what was tried, and --happened or --again (ADR-0002 §2)",
    )
    .option("--happened", "it is there: record it done, the run goes on without doing it again")
    .option("--again", "it is not there: the run does it again")
    .option("--note <text>", "why, for the record")
    .action(async (run: string, opts: { happened?: boolean; again?: boolean; note?: string }) => {
      await runEffect(ctxFor(), run, opts);
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
    .command("stats [modelId]")
    .description("how the models behave: answered/failed, retries and why, latency, speed, tokens")
    .option("--since <age>", "window, e.g. 2h, 1d (default 24h)")
    .action(async (modelId: string | undefined, opts: { since?: string }) => {
      await runModelsStats(ctxFor(), modelId, opts.since ? { since: opts.since } : {});
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
    .command("call <capability>")
    .description(
      "call one read capability as an agent would (jira.get, confluence.get, …) and print what it returns",
    )
    .option(
      "--arg <key=value>",
      "an argument of the capability; repeat for more (true/false become booleans)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--full", "the whole answer, not cut where an agent's is", false)
    .option("--out <file>", "write the whole answer to a file")
    .action(async (capability: string, opts: { arg: string[]; full: boolean; out?: string }) => {
      await runMcpCall(ctxFor(), capability, opts);
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
    .option("--suite <name|dir>", "suite under evals/ or a directory", "default")
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
    .option("--suite <name|dir>", "suite to add the case to", "default")
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
    .command("candidates")
    .description(
      "finished runs worth keeping as eval cases (sent back, looped or edited by a person), with why",
    )
    .option("--dismiss <run>", "take a run off the list: it is no case")
    .action(async (opts: { dismiss?: string }) => {
      await runEvalsCandidates(ctxFor(), opts);
    });
  evals
    .command("schedule")
    .description("the suites the daemon runs on a schedule (evals.schedule): last run and next")
    .action(async () => {
      await runEvalsSchedule(ctxFor());
    });
  evals
    .command("baseline [suite]")
    .description("pin the latest result of the suite as its baseline")
    .option("--from <file>", "use this result file instead of the latest")
    .action(async (suite: string | undefined, opts: { from?: string }) => {
      await runEvalsBaseline(ctxFor(), suite ?? "default", opts);
    });
  evals
    .command("diff [suite]")
    .description("compare the latest result with the baseline; non-zero on regression beyond tolerance")
    .option("--tolerance <ratio>", "allowed relative drop", Number.parseFloat, 0.05)
    .option("--from <file>", "compare this result file instead of the latest")
    .action(async (suite: string | undefined, opts: { tolerance: number; from?: string }) => {
      await runEvalsDiff(ctxFor(), suite ?? "default", opts);
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
    .description(
      "answer a clarification thread asynchronously (--accept takes the proposed rule), or a conflict with a hand edit: mine | run | merge",
    )
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

  program
    .command("scope <run>")
    .description("the scope gate of an sdd whose impact reaches other services (ADR-0025 §7)")
    .option("--cross", "go on as a task across services: a master run in the knowledge repository")
    .option("--single", "only this service: go on to the plan, not asked again")
    .option("--resume", "with --single: go on now in the foreground")
    .action(async (ref: string, opts: { cross?: boolean; single?: boolean; resume?: boolean }) => {
      await runScope(ctxFor(), ref, opts);
    });
  const subtask = program
    .command("subtask")
    .description("the subtasks of a task across services (ADR-0025 §6); each is a run of its own");
  subtask
    .command("list <master>")
    .description("the master's subtasks: service, state, run")
    .action(async (master: string) => {
      await runSubtaskList(ctxFor(), master);
    });
  subtask
    .command("start <master> <subtask>")
    .description(
      "start a queued subtask now (by its number or service), past the parallel limit — or one that waits for a library, without its new version",
    )
    .action(async (master: string, which: string) => {
      await runSubtaskStart(ctxFor(), master, which);
    });
  subtask
    .command("retry <master> <subtask>")
    .description("a cancelled subtask starts anew; a stopped one says how to resume it")
    .action(async (master: string, which: string) => {
      await runSubtaskRetry(ctxFor(), master, which);
    });
  subtask
    .command("drop <master> <subtask>")
    .description("take a subtask out of the task; the master goes on without it")
    .action(async (master: string, which: string) => {
      await runSubtaskDrop(ctxFor(), master, which);
    });
  subtask
    .command("publish <master> <subtask>")
    .description("publish-local of an accepted library subtask again; the services waiting for it start")
    .action(async (master: string, which: string) => {
      await runSubtaskPublish(ctxFor(), master, which);
    });
  subtask
    .command("contract <master> [subtask]")
    .description(
      "a subtask's request to change the contract: --accept (a new version of the split) or --reject (it goes on as agreed)",
    )
    .option("--accept", "change the contract as the subtask asks (or as --change says)")
    .option("--change <text>", "with --accept: the contract item's change as it will be")
    .option("--reject", "keep the contract as agreed; the subtask goes on with it")
    .option("--why <text>", "with --reject: why, for the subtask")
    .action(
      async (
        master: string,
        which: string | undefined,
        opts: { accept?: boolean; reject?: boolean; change?: string; why?: string },
      ) => {
        await runSubtaskContract(ctxFor(), master, which, opts);
      },
    );
  subtask
    .command("run <master> <subtask>")
    .description("(started by the master) the subtask's run in its service's repository")
    .action(async (master: string, which: string) => {
      await runSubtaskRun(ctxFor(), master, which);
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
      "index knowledge, standards, skills and source files for search (FTS5; vectors when knowledge.retrieval.embeddings is set)",
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
    .command("eval")
    .description(
      "retrieval quality on labelled cases: Recall@5/@10, MRR, irrelevant ratio, tokens; compared with the baseline (ADR-0015 §6)",
    )
    .option("--cases <file>", "cases file", "evals/retrieval/cases.yaml")
    .option("--no-glossary", "search without glossary expansion (what the glossary adds)")
    .option("--baseline", "pin this result as the baseline", false)
    .option("--tolerance <ratio>", "allowed relative drop", Number.parseFloat, 0.05)
    .option("--out <file>", "result file (default: evals/results/<date>-retrieval.json)")
    .action(
      async (opts: {
        cases: string;
        glossary: boolean;
        baseline: boolean;
        tolerance: number;
        out?: string;
      }) => {
        await runKnowledgeEval(ctxFor(), opts);
      },
    );
  knowledge
    .command("links")
    .description(
      "links between services the contract catalog of a knowledge repository finds, as a checklist (ADR-0025 §4)",
    )
    .option("--service <name>", "only the links of this service")
    .action(async (opts: { service?: string }) => {
      await runKnowledgeLinks(ctxFor(), opts);
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
    .description("knowledge candidates from reviews, repeated findings and people (ADR-0020 §6)");
  candidates
    .command("add <kind> <title> [text...]")
    .description(
      "propose a candidate by hand: standard | knowledge | skill-improvement; the text from the argument, --file or stdin",
    )
    .option("--file <path>", "read the text from a file")
    .option("--skill <id>", "skill-improvement: the skill it improves (required there)")
    .option(
      "--path <glob>",
      "code it applies to (repeatable)",
      (v: string, prev: string[]) => [...prev, v],
      [],
    )
    .option(
      "--evidence <ref>",
      "where it shows: path:line, a run, a link (repeatable)",
      (v: string, prev: string[]) => [...prev, v],
      [],
    )
    .option("--why <text>", "why it should be written down")
    .action(
      async (
        kind: string,
        title: string,
        text: string[],
        opts: { file?: string; skill?: string; path: string[]; evidence: string[]; why?: string },
      ) => {
        await runCandidatesAdd(ctxFor(), kind, title, text, opts);
      },
    );
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
    .option(
      "--replace",
      "replace a document a person wrote at the target (a generated one is replaced anyway)",
      false,
    )
    .action(async (name: string, opts: { id?: string; replace?: boolean }) => {
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
  const stale = staleBuild();
  if (stale) {
    // stderr only: --json output and exit codes stay as they are
    streams.err.write(
      `warning: jarvis runs a build of ${stale.built.slice(0, 7)}, the checkout is at ${stale.head.slice(0, 7)} — run \`pnpm build\` in ${stale.root}\n`,
    );
  }
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
      const d = DIAGNOSES.find((x) => x.code === "J008") as (typeof DIAGNOSES)[number];
      streams.err.write(`error[${d.code}]: ${error.message}\n  help: ${d.help.replace(/`/g, "")}\n`);
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
