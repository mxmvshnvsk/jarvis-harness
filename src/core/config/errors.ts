import type { ZodError } from "zod";

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
  /** Where the offending value came from, when known. */
  readonly source?: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(message: string, issues: readonly ConfigIssue[]) {
    super(issues.length > 0 ? `${message}\n${issues.map(formatIssue).join("\n")}` : message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function formatIssue(issue: ConfigIssue): string {
  const where = issue.path === "" ? "(root)" : issue.path;
  return issue.source ? `  ${where}: ${issue.message}  [${issue.source}]` : `  ${where}: ${issue.message}`;
}

export function zodIssues(error: ZodError, sources: Record<string, string> = {}): ConfigIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path
      .map((segment, i) => {
        const s = String(segment);
        if (/[.\s"[\]]/.test(s)) return `["${s}"]`;
        return i === 0 ? s : `.${s}`;
      })
      .join("");
    const source = sources[path] ?? nearestSource(path, sources);
    return source ? { path, message: issue.message, source } : { path, message: issue.message };
  });
}

function nearestSource(path: string, sources: Record<string, string>): string | undefined {
  // Fall back to any source under this path (e.g. an object-level issue).
  for (const [key, source] of Object.entries(sources)) {
    if (key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) return source;
  }
  return undefined;
}
