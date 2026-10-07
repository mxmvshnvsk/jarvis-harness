import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { createKeychain } from "../../app/runtime.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import { ConfigError, isSecretRef, type LoadedConfig, parseSecretRef } from "../../core/config/index.ts";
import { EnvSecretResolver } from "../../core/config/secrets.ts";
import { jarvisHome } from "../../core/paths.ts";
import { McpPool, ToolsCache } from "../../mcp/client/pool.ts";
import { McpToolProvider, type ServerReport } from "../../mcp/provider.ts";
import { ProbeStore, probeDrift, probeIsStale } from "../../models/probe.ts";
import { evaluateEgress, formatEgressLine } from "../../security/policy/egress.ts";
import { LATEST_SCHEMA_VERSION, openDatabase, SchemaTooNewError } from "../../storage/index.ts";
import { logLevelFrom, logSettingsFrom } from "../../telemetry/log.ts";
import { hasRipgrep } from "../../tools/local/exec.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";
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

function check(id: string, status: CheckStatus, subject: string, detail: string, hint?: string): Check {
  return hint ? { id, status, subject, detail, hint } : { id, status, subject, detail };
}

function commandExists(command: string, env: NodeJS.ProcessEnv, cwd: string): boolean {
  const executable = command.trim().split(/\s+/)[0];
  if (!executable) return false;
  if (executable.includes("/")) {
    return existsSync(isAbsolute(executable) ? executable : join(cwd, executable));
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
      checks.push(
        check(
          "project",
          "warn",
          "project",
          `${loaded.project.root} has no .jarvis/project.yaml`,
          "run `jarvis init`",
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
    const report: DoctorReport = {
      checks,
      egress: formatEgressLine(egress),
      ok: !checks.some((c) => c.status === "fail"),
    };
    return report;
  }

  checks.push(...databaseChecks(home.dbFile), logCheck(home.logsDir, ctx.env));
  return { checks, ok: !checks.some((c) => c.status === "fail") };
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

interface SecretRefAt {
  readonly path: string;
  readonly value: `env:${string}` | `keychain:${string}`;
}

function collectSecretRefs(loaded: LoadedConfig): SecretRefAt[] {
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
