import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { createKeychain } from "../../app/runtime.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import { ConfigError, isSecretRef, type LoadedConfig, parseSecretRef } from "../../core/config/index.ts";
import { missingChecks } from "../../core/config/requiredChecks.ts";
import { EnvSecretResolver } from "../../core/config/secrets.ts";
import { jarvisHome } from "../../core/paths.ts";
import { loadSkills } from "../../knowledge/skills.ts";
import { knowledgeRootsOf } from "../../knowledge/sources.ts";
import { loadStandards } from "../../knowledge/standards.ts";
import { McpPool, ToolsCache } from "../../mcp/client/pool.ts";
import { McpToolProvider, type ServerReport } from "../../mcp/provider.ts";
import { ProbeStore, probeDrift, probeIsStale } from "../../models/probe.ts";
import { evaluateEgress, formatEgressLine } from "../../security/policy/egress.ts";
import {
  formatRedactionStats,
  highEntropyBurst,
  type RedactionWindows,
  redactionWindows,
} from "../../security/redactionStats.ts";
import { LATEST_SCHEMA_VERSION, openDatabase, SchemaTooNewError } from "../../storage/index.ts";
import { SqliteEventStore } from "../../telemetry/events.ts";
import { logLevelFrom, logSettingsFrom } from "../../telemetry/log.ts";
import { hasRipgrep } from "../../tools/local/exec.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";
import { unscopedShared } from "./knowledge.ts";
import { logDirSummary } from "./logs.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  readonly subject: string;
  readonly detail: string;
  readonly hint?: string;
}

export interface DoctorReport {
  readonly checks: readonly Check[];
  readonly egress?: string;
  /** What the Redactor masked over the last day and week (ADR-0010 §4). */
  readonly redactions?: RedactionWindows;
  readonly ok: boolean;
}

export const MIN_NODE = "22.18.0";

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function check(
  id: string,
  status: CheckStatus,
  subject: string,
  detail: string,
  hint?: string,
): Check {
  return hint ? { id, status, subject, detail, hint } : { id, status, subject, detail };
}

/**
 * The program a command line runs, found: after `cd <dir> &&` (from that directory) and variables set
 * for it (`TZ=Europe/Paris ./gradlew test`). Pilot: the variable was reported as a missing executable.
 */
export function commandExists(command: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  let words = command.trim().split(/\s+/);
  let dir = cwd;
  if (words[0] === "cd" && words[1] && words[2] === "&&") {
    dir = isAbsolute(words[1]) ? words[1] : join(cwd, words[1]);
    words = words.slice(3);
  }
  while (words[0] && /^[A-Za-z_]\w*=/.test(words[0])) words = words.slice(1);
  const executable = words[0];
  if (!executable) return false;
  if (executable.includes("/")) {
    return existsSync(isAbsolute(executable) ? executable : join(dir, executable));
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, executable), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export async function runDoctor(ctx: CliContext): Promise<DoctorReport> {
  const checks: Check[] = [];
  const nodeVersion = process.versions.node;
  checks.push(
    compareVersions(nodeVersion, MIN_NODE) >= 0
      ? check("node", "ok", "node", `v${nodeVersion}`)
      : check("node", "fail", "node", `v${nodeVersion} is older than ${MIN_NODE}`, "upgrade Node.js"),
  );

  let loaded: LoadedConfig | undefined;
  try {
    loaded = await loadForCli(ctx);
  } catch (error) {
    if (error instanceof ConfigError) {
      checks.push(
        check(
          "config",
          "fail",
          "config",
          error.issues
            .map((i) => `${i.path || "(root)"}: ${i.message}${i.source ? ` [${i.source}]` : ""}`)
            .join("; "),
          "fix the configuration, then run `jarvis config show --sources`",
        ),
      );
    } else {
      throw error;
    }
  }

  const home = jarvisHome(ctx.env, ctx.homeDir);
  checks.push(
    existsSync(home.configFile)
      ? check("config.user", "ok", "user config", home.configFile)
      : check("config.user", "warn", "user config", `${home.configFile} is missing`, "run `jarvis init`"),
  );

  if (loaded) {
    // the budget judge of autonomous runs on the worker's model judges that model's own work
    if (loaded.config.human.arbiter.enabled && !loaded.config.roles.arbiter)
      checks.push(
        check(
          "arbiter",
          "warn",
          "budget judge",
          "runs on the review role's model, the same family that does the work",
          "a model of its own for autonomous runs: roles.arbiter.models (a cheap one, or another family)",
        ),
      );
    if (!loaded.project) {
      checks.push(
        check(
          "project",
          "warn",
          "project",
          "no .jarvis/project.yaml or .git found upwards",
          "run `jarvis init` in the project",
        ),
      );
    } else if (!loaded.files.project?.exists) {
      // next to a knowledge repository that does not map this one (ADR-0025 §3)
      const unmapped = loaded.warnings.find((w) =>
        w.includes("is not a service of the knowledge repository"),
      );
      checks.push(
        unmapped
          ? check("project", "warn", "project", unmapped, "map it, or `jarvis init` for a .jarvis of its own")
          : check(
              "project",
              "warn",
              "project",
              `${loaded.project.root} has no .jarvis/project.yaml`,
              "run `jarvis init`",
            ),
      );
    } else if (loaded.meta) {
      const meta = loaded.meta;
      checks.push(
        check(
          "project",
          "ok",
          "project",
          meta.service
            ? `${loaded.project.root} — service ${meta.service} of the knowledge repository ${meta.root}`
            : `knowledge repository ${meta.root}: ${Object.keys(meta.repos).length} services`,
        ),
      );
      // the map as this machine has it: every repository there, no two services on one folder
      const missing = Object.entries(meta.repos).filter(([, path]) => !existsSync(path));
      const byPath = new Map<string, string[]>();
      for (const [name, path] of Object.entries(meta.repos))
        byPath.set(path, [...(byPath.get(path) ?? []), name]);
      const shared = [...byPath.values()].filter((names) => names.length > 1);
      checks.push(
        missing.length === 0 && shared.length === 0
          ? check(
              "knowledge.repos",
              "ok",
              "service map",
              `${Object.keys(meta.repos).length} repositories found`,
            )
          : check(
              "knowledge.repos",
              "warn",
              "service map",
              [
                ...missing.map(([name, path]) => `${name}: no repository at ${path}`),
                ...shared.map((names) => `${names.join(", ")} map to one folder`),
              ].join("; "),
              `services.<name>.repo in ${meta.configFile}, or repos.<name> in ${home.configFile} for this machine`,
            ),
      );
    } else {
      checks.push(check("project", "ok", "project", loaded.project.root));
    }
    if (loaded.project && !loaded.project.isGitRepo) {
      checks.push(
        check("git", "warn", "git", "project is not a git repository", "worktree mode needs git (ADR-0003)"),
      );
    }

    // what the project expects of this machine and it does not have: no failure, a note
    for (const warning of loaded.warnings.filter(
      (w) => w.startsWith("egressExceptions") || w.startsWith("modelEgressExceptions"),
    ))
      checks.push(
        check(
          "config.egress",
          "warn",
          "egress exception",
          warning,
          warning.startsWith("modelEgressExceptions")
            ? "add the model to ~/.jarvis/config.yaml models if the project needs it"
            : "add the server to ~/.jarvis/config.yaml mcp.servers if the project needs it",
        ),
      );

    // a knowledge repository of many services: shared rules that name no stack reach every one of them
    if (loaded.meta && Object.keys(loaded.meta.repos).length > 1 && loaded.project) {
      const roots = knowledgeRootsOf(loaded, loaded.project.root);
      const unscoped = unscopedShared(loaded, [
        ...loadStandards(roots).map((x) => ({
          id: x.id,
          level: x.level,
          stacks: x.scope.stacks,
          folderScoped: x.folderScoped,
        })),
        ...loadSkills(roots)
          .filter((x) => !x.source && x.format !== "agent-skills")
          .map((x) => ({
            id: x.id,
            level: x.level,
            stacks: x.appliesTo.stacks,
            folderScoped: x.folderScoped,
          })),
      ]);
      if (unscoped.length > 0)
        checks.push(
          check(
            "knowledge.unscoped",
            "warn",
            "stacks",
            `${unscoped.length} standard(s)/skill(s) name no stack and reach every service: ${unscoped.slice(0, 6).join(", ")}${unscoped.length > 6 ? ", …" : ""}`,
            "put them in a folder with _scope.yaml ({ stacks: [java] }), or in common/ with an empty one to mean «everyone»; jarvis standards list --service <name> shows what a service gets",
          ),
        );
    }

    const models = Object.keys(loaded.config.models).length;
    const pools = Object.keys(loaded.config.quotaPools).length;
    const roles = Object.keys(loaded.config.roles).length;
    checks.push(
      check(
        "config",
        models === 0 ? "warn" : "ok",
        "config",
        `${models} model(s), ${pools} quota pool(s), ${roles} role(s)${loaded.config.profile ? `, profile ${loaded.config.profile}` : ""}`,
        models === 0 ? "add a model to ~/.jarvis/config.yaml (ADR-0017 §2)" : undefined,
      ),
    );

    const keychain = createKeychain(loaded, ctx.env);
    const actor = await resolveActor(loaded.config, ctx.env, loaded.project?.root);
    checks.push(
      actor.actor
        ? check("actor", "ok", "actor", `${actor.actor.kind}:${actor.actor.id} (${actor.source})`)
        : check(
            "actor",
            "warn",
            "actor",
            "cannot determine the actor",
            "set JARVIS_ACTOR, actor.id or git config user.email (ADR-0006)",
          ),
    );

    for (const ref of collectSecretRefs(loaded)) {
      const parsed = parseSecretRef(ref.value);
      if (parsed.kind === "env") {
        const present = Boolean(ctx.env[parsed.name]);
        checks.push(
          present
            ? check(`secret:${ref.value}`, "ok", "secret", `${ref.path} → ${ref.value} is set`)
            : check(
                `secret:${ref.value}`,
                "warn",
                "secret",
                `${ref.path} → ${ref.value} is not set in the environment`,
              ),
        );
      } else {
        const present = (await keychain.get(parsed.name)) !== undefined;
        checks.push(
          present
            ? check(
                `secret:${ref.value}`,
                "ok",
                "secret",
                `${ref.path} → ${ref.value} is set (${keychain.backend.kind})`,
              )
            : check(
                `secret:${ref.value}`,
                "warn",
                "secret",
                `${ref.path} → ${ref.value} is not in the keychain (${keychain.backend.kind})`,
                `run \`jarvis auth set ${parsed.name}\` (ADR-0017 §5)`,
              ),
        );
      }
    }
    if (keychain.backend.kind === "file") {
      checks.push(
        check(
          "keychain",
          Object.keys(loaded.config.mcp.servers).length > 0 || collectSecretRefs(loaded).length > 0
            ? "warn"
            : "ok",
          "keychain",
          `file backend (${join(home.root, "credentials.json")}, mode 0600) — no OS keychain found`,
          "install libsecret (`secret-tool`) or use macOS Keychain for keychain: references",
        ),
      );
    }

    for (const report of mcpReports(loaded, ctx.env)) {
      if (report.error) {
        checks.push(check(`mcp:${report.id}`, "fail", "mcp", `${report.id}: ${report.error}`));
        continue;
      }
      const parts = [`${report.transport}`, `network ${report.network}`];
      if (report.profile) parts.push(`profile ${report.profile}`);
      parts.push(
        report.discovered
          ? `discovered ${report.discovered.at.slice(0, 10)} (${report.discovered.count} tools)`
          : "never discovered",
      );
      parts.push(`${report.exposed.length} exposed`);
      const hints: string[] = [];
      if (report.unmapped.length > 0) hints.push(`unmapped: ${report.unmapped.join(", ")}`);
      if (report.notAllowed.length > 0)
        hints.push(`discovered, not allowed: ${report.notAllowed.join(", ")}`);
      const status =
        (!report.profile && !report.discovered) || report.unmapped.length > 0 || report.notAllowed.length > 0
          ? "warn"
          : "ok";
      checks.push(
        check(
          `mcp:${report.id}`,
          status,
          "mcp",
          `${report.id}: ${parts.join(", ")}${hints.length > 0 ? ` — ${hints.join("; ")}` : ""}`,
          status === "warn"
            ? "run `jarvis mcp list --refresh` and adjust allow/deny (ADR-0017 §6)"
            : undefined,
        ),
      );
    }

    checks.push(
      commandExists("git", ctx.env, ctx.cwd)
        ? check("tool:git", "ok", "local tool", "git available")
        : check(
            "tool:git",
            "fail",
            "local tool",
            "git not found in PATH",
            "worktrees and checkpoints need git (ADR-0003)",
          ),
    );
    checks.push(
      (await hasRipgrep())
        ? check("tool:rg", "ok", "local tool", "ripgrep available")
        : check(
            "tool:rg",
            "warn",
            "local tool",
            "ripgrep (rg) not found; repo.search falls back to a slower JS search",
          ),
    );
    for (const [name, command] of Object.entries(loaded.config.tools.local)) {
      checks.push(
        commandExists(command, ctx.env, loaded.project?.root ?? ctx.cwd)
          ? check(`tool:${name}`, "ok", "local tool", `${name}: ${command}`)
          : check(
              `tool:${name}`,
              "warn",
              "local tool",
              `${name}: "${command}" — executable not found in PATH`,
            ),
      );
    }

    // the checks the project said it must have (tools.required): what is missing is a warning, the rest optional
    const missingTools = missingChecks(loaded.config.tools.required, Object.keys(loaded.config.tools.local));
    checks.push(
      missingTools.length === 0
        ? check(
            "tools:required",
            "ok",
            "local tool",
            `required checks set: ${loaded.config.tools.required.join(", ")}`,
          )
        : check(
            "tools:required",
            "warn",
            "local tool",
            `no command for ${missingTools.join(", ")} (tools.required) — set tools.local, or jarvis onboard`,
          ),
    );

    const probes = new ProbeStore(home.cacheDir);
    for (const [id, model] of Object.entries(loaded.config.models)) {
      const probe = probes.get(id);
      if (!probe) {
        checks.push(
          check(
            `probe:${id}`,
            "warn",
            "model probe",
            `${id}: never probed`,
            `run \`jarvis models probe ${id}\``,
          ),
        );
        continue;
      }
      const drift = probeDrift(model, probe);
      if (drift.length > 0) {
        checks.push(
          check(
            `probe:${id}`,
            "warn",
            "model probe",
            `${id}: config disagrees with probe — ${drift.map((x) => `${x.capability} (config ${x.configured}, probe ${x.probed})`).join(", ")}`,
            "fix supports in the model descriptor (ADR-0007 §1)",
          ),
        );
      } else if (probeIsStale(probe)) {
        checks.push(
          check(
            `probe:${id}`,
            "warn",
            "model probe",
            `${id}: probe older than 30 days (${probe.probedAt.slice(0, 10)})`,
            `run \`jarvis models probe ${id}\``,
          ),
        );
      } else {
        checks.push(check(`probe:${id}`, "ok", "model probe", `${id}: ${probe.probedAt.slice(0, 10)}`));
      }
    }

    const egress = evaluateEgress(loaded.config);
    for (const m of egress.models) {
      if (!m.allowed)
        checks.push(check(`egress:model:${m.id}`, "warn", "egress", `model ${m.id}: ${m.reason}`));
      else if (m.exception)
        checks.push(
          check(
            `egress:exception:model:${m.id}`,
            "warn",
            "egress",
            `model ${m.id}: a cloud model for dataClass ${egress.dataClass} by an exception: ${m.exception}`,
          ),
        );
    }
    for (const s of egress.servers) {
      if (!s.allowed)
        checks.push(check(`egress:mcp:${s.id}`, "warn", "egress", `mcp server ${s.id}: ${s.reason}`));
      else if (s.exception)
        checks.push(
          check(
            `egress:exception:${s.id}`,
            "warn",
            "egress",
            `mcp server ${s.id}: out of dataClass ${egress.dataClass} by an exception (reads only): ${s.exception}`,
          ),
        );
    }
    if (!egress.telemetryExport.allowed) {
      checks.push(
        check(
          "egress:telemetry",
          "fail",
          "egress",
          egress.telemetryExport.reason ?? "telemetry export denied",
        ),
      );
    }

    checks.push(...databaseChecks(home.dbFile), logCheck(home.logsDir, ctx.env));
    const redactions = readRedactions(home.dbFile);
    if (redactions) checks.push(redactionCheck(redactions));
    const report: DoctorReport = {
      checks,
      egress: formatEgressLine(egress),
      ...(redactions ? { redactions } : {}),
      ok: !checks.some((c) => c.status === "fail"),
    };
    return report;
  }

  checks.push(...databaseChecks(home.dbFile), logCheck(home.logsDir, ctx.env));
  const redactions = readRedactions(home.dbFile);
  if (redactions) checks.push(redactionCheck(redactions));
  return { checks, ...(redactions ? { redactions } : {}), ok: !checks.some((c) => c.status === "fail") };
}

/** The journal's redaction counts (ADR-0010 §4); none without a database doctor can read. */
export function readRedactions(dbFile: string, now: Date = new Date()): RedactionWindows | undefined {
  if (!existsSync(dbFile)) return undefined;
  try {
    const opened = openDatabase(dbFile, { migrate: false });
    try {
      return redactionWindows(new SqliteEventStore(opened.db), now);
    } finally {
      opened.close();
    }
  } catch {
    // a newer or broken schema is the database check's to report
    return undefined;
  }
}

export function redactionCheck(w: RedactionWindows): Check {
  const detail = `24h ${formatRedactionStats(w.last24h)} · 7d ${formatRedactionStats(w.last7d)}`;
  return highEntropyBurst(w.last24h)
    ? check(
        "redactions",
        "warn",
        "redactions",
        detail,
        "many high-entropy guesses: look at what the project keeps in code; `jarvis show <run>` lists their shapes",
      )
    : check("redactions", "ok", "redactions", detail);
}

function mcpReports(loaded: LoadedConfig, env: NodeJS.ProcessEnv): ServerReport[] {
  const pool = new McpPool({
    servers: loaded.config.mcp.servers,
    secrets: new EnvSecretResolver(env),
    cache: new ToolsCache(join(loaded.home.cacheDir, "mcp")),
    env,
  });
  return new McpToolProvider(loaded.config, pool).reports();
}

function logCheck(dir: string, env: NodeJS.ProcessEnv): Check {
  const level = logLevelFrom(env);
  if (level === "off")
    return check(
      "logs",
      "warn",
      "technical log",
      "off (JARVIS_LOG=off): failures will leave only the journal's counters",
      "unset JARVIS_LOG or set it to info / debug",
    );
  const { files, bytes } = logDirSummary(dir);
  return check(
    "logs",
    "ok",
    "technical log",
    `level ${level} → ${dir} (${files} file(s), ${Math.ceil(bytes / 1024)} KB, kept ${logSettingsFrom(env).keepDays} days); read with \`jarvis logs\`${level === "debug" ? "" : "; JARVIS_LOG=debug adds model and tool bodies"}`,
  );
}

function databaseChecks(dbFile: string): Check[] {
  if (!existsSync(dbFile)) {
    return [check("db", "warn", "database", `${dbFile} does not exist`, "run `jarvis init`")];
  }
  try {
    const opened = openDatabase(dbFile, { migrate: false });
    const pending = LATEST_SCHEMA_VERSION - opened.schemaVersion;
    opened.close();
    const backups = readdirSync(dirname(dbFile)).filter((f) => f.startsWith(`${basename(dbFile)}.bak-`));
    const backupNote = backups.length > 0 ? `, backup ${backups[0]}` : "";
    if (pending > 0) {
      return [
        check(
          "db",
          "warn",
          "database",
          `schema v${opened.schemaVersion}, ${pending} migration(s) pending${backupNote}`,
          "run `jarvis db migrate`",
        ),
      ];
    }
    return [check("db", "ok", "database", `schema v${opened.schemaVersion}${backupNote}`)];
  } catch (error) {
    if (error instanceof SchemaTooNewError) {
      return [check("db", "fail", "database", error.message, "upgrade jarvis")];
    }
    return [check("db", "fail", "database", error instanceof Error ? error.message : String(error))];
  }
}

export interface SecretRefAt {
  readonly path: string;
  readonly value: `env:${string}` | `keychain:${string}`;
}

export function collectSecretRefs(loaded: LoadedConfig): SecretRefAt[] {
  const refs: SecretRefAt[] = [];
  const visit = (value: unknown, path: string) => {
    if (isSecretRef(value)) {
      refs.push({ path, value });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        visit(v, `${path}[${i}]`);
      });
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k);
    }
  };
  visit(loaded.config.models, "models");
  visit(loaded.config.mcp, "mcp");
  return refs;
}

export function renderDoctor(ctx: CliContext, report: DoctorReport): void {
  const { out } = ctx;
  const st = out.style;
  const label: Record<CheckStatus, string> = {
    ok: st.ok("OK  "),
    warn: st.warn("WARN"),
    fail: st.bad("FAIL"),
  };
  out.line(st.heading("jarvis doctor"));
  const width = Math.max(...report.checks.map((c) => c.subject.length));
  for (const c of report.checks) {
    const detail = c.status === "ok" ? st.muted(c.detail) : c.detail;
    out.line(`  ${label[c.status]}  ${padEnd(c.subject, width)}  ${detail}`);
    if (c.hint) out.line(`        ${" ".repeat(width)}  ${st.muted("→")} ${st.cmd(c.hint)}`);
  }
  if (report.egress) {
    out.line();
    out.line(report.egress);
  }
  if (!report.ok) throw new CliExit(EXIT.error);
}
