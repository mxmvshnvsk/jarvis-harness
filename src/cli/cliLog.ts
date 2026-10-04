import { jarvisHome } from "../core/paths.ts";
import { Redactor } from "../security/redactor.ts";
import { Logger, logLevelFrom, logSettingsFrom, NULL_LOGGER } from "../telemetry/log.ts";
import type { CliContext } from "./context.ts";

/**
 * Logger for what happens around a command, before any runtime exists: the invocation, its exit code
 * and an unexpected crash with its stack. Same files as the runtime's logger, so one `jarvis logs`
 * shows both.
 */
export function cliLogger(context: Partial<CliContext> | undefined): Logger {
  try {
    const env = context?.env ?? process.env;
    const level = logLevelFrom(env);
    if (level === "off") return NULL_LOGGER;
    const home = jarvisHome(env, context?.homeDir);
    const redactor = new Redactor();
    return new Logger({
      dir: home.logsDir,
      level,
      redact: (text) => redactor.redact(text).text,
      ...logSettingsFrom(env),
    });
  } catch {
    return NULL_LOGGER;
  }
}
