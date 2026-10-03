import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { resolveActor } from "../../core/actor/resolve.ts";
import { ConfigError, isSecretRef, type LoadedConfig, parseSecretRef } from "../../core/config/index.ts";
import { jarvisHome } from "../../core/paths.ts";
import { evaluateEgress, formatEgressLine } from "../../security/policy/egress.ts";
import { LATEST_SCHEMA_VERSION, openDatabase, SchemaTooNewError } from "../../storage/index.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";

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
        checks.push(
          check(
            `secret:${ref.value}`,
            "warn",
            "secret",
            `${ref.path} → ${ref.value}: keychain backend is not available yet`,
            "use env:VAR until `jarvis auth` ships (ADR-0017 §5)",
          ),
        );
      }
    }

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

    const egress = evaluateEgress(loaded.config);
    for (const m of egress.models) {
      if (!m.allowed)
        checks.push(check(`egress:model:${m.id}`, "warn", "egress", `model ${m.id}: ${m.reason}`));
    }
    for (const s of egress.servers) {
      if (!s.allowed)
        checks.push(check(`egress:mcp:${s.id}`, "warn", "egress", `mcp server ${s.id}: ${s.reason}`));
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

    checks.push(...databaseChecks(home.dbFile));
    const report: DoctorReport = {
      checks,
      egress: formatEgressLine(egress),
      ok: !checks.some((c) => c.status === "fail"),
    };
    return report;
  }

  checks.push(...databaseChecks(home.dbFile));
  return { checks, ok: !checks.some((c) => c.status === "fail") };
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
  const label: Record<CheckStatus, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  out.line("jarvis doctor");
  const width = Math.max(...report.checks.map((c) => c.subject.length));
  for (const c of report.checks) {
    out.line(`  ${label[c.status]}  ${padEnd(c.subject, width)}  ${c.detail}`);
    if (c.hint) out.line(`        ${" ".repeat(width)}  → ${c.hint}`);
  }
  if (report.egress) {
    out.line();
    out.line(report.egress);
  }
  if (!report.ok) throw new CliExit(EXIT.error);
}
