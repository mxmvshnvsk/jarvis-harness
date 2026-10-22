import type { DeliveryConfig } from "../core/config/schema.ts";
import { slugOf } from "../orchestration/worktree.ts";
import { packageInfo } from "../version.ts";

/**
 * The team's formats for what a run delivers (`delivery`): the branch it is pushed as, the commit
 * message, the PR's title, and the trailers that say Jarvis made it. The author is always the person
 * (their git config); the trailers are the mark.
 */

export interface FormatInput {
  /** The task's text: its issue key is taken from it. */
  readonly task: string;
  /** What it is about: the spec's title, else the task. */
  readonly title: string;
  /** The run's kind of task (`--kind`): `{type}`. */
  readonly kind?: string;
  /** The files changed: `{scope}` when `auto`. */
  readonly files: readonly string[];
  /** The service the run changes in a map of services: `{scope}` when `auto`. */
  readonly service?: string;
  readonly runId: string;
}

/** Why a format cannot be filled: the team's format wants the issue key and the task has none. */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

const KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;
/** A header past this is cut (Conventional Commits, commitlint's default). */
const HEADER_MAX = 72;

export function issueKeyOf(text: string): string | undefined {
  return KEY.exec(text)?.[0];
}

/** Folders that say where in a repository code is, not what part of the product it is. */
const PLAIN = new Set([
  "src",
  "main",
  "test",
  "tests",
  "lib",
  "java",
  "kotlin",
  "groovy",
  "resources",
  "app",
]);
const GROUPS = new Set(["packages", "apps", "services", "modules", "libs"]);

/**
 * `{scope}` when `auto`: the service of the map; else the module most of the change is in
 * (`packages/<name>`, `apps/<name>`, or a top folder that is not `src`); else none.
 */
export function scopeOf(files: readonly string[], service: string | undefined): string {
  if (service) return service;
  const count = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    const name =
      parts.length > 2 && GROUPS.has(parts[0] as string)
        ? parts[1]
        : parts.length > 1 && !PLAIN.has(parts[0] as string)
          ? parts[0]
          : undefined;
    if (name) count.set(name, (count.get(name) ?? 0) + 1);
  }
  const [best] = [...count.entries()].sort((a, b) => b[1] - a[1]);
  // a module that has most of the change, not one of many
  return best && best[1] * 2 > files.length ? best[0] : "";
}

/** The subject: the title without the issue key at its start and a full stop at its end. */
function subjectOf(title: string, key: string | undefined): string {
  let s = title.trim().split("\n")[0] as string;
  if (key) s = s.replace(new RegExp(`^\\[?${key}\\]?[:\\s-]*`), "");
  return s.replace(/[.\s]+$/, "").trim();
}

function fill(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "")
    .replace(/\(\s*\)/g, "") // an empty scope: `feat(): …` → `feat: …`
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function valuesOf(cfg: DeliveryConfig, input: FormatInput, template: string) {
  const key = issueKeyOf(input.task);
  if (/\{key\}/.test(template) && !key)
    throw new FormatError(
      `the team's format (${template}) wants the issue key, and the task names none: start the run with the key (ABC-42 …)`,
    );
  const scope =
    cfg.commit.scope === "auto"
      ? scopeOf(input.files, input.service)
      : cfg.commit.scope === "none"
        ? ""
        : cfg.commit.scope;
  return {
    key: key ?? "",
    type: cfg.commit.types[input.kind ?? "change"] ?? cfg.commit.types.change ?? "feat",
    scope,
    // the key goes where the format puts it, not twice
    subject: subjectOf(input.title, /\{key\}/.test(template) ? key : undefined),
    run: input.runId.replace(/^run_/, "").slice(0, 8),
  };
}

/** A header from a template, its subject cut at a word so the line stays within 72 characters. */
export function headerOf(cfg: DeliveryConfig, input: FormatInput, template: string): string {
  const values = valuesOf(cfg, input, template);
  const whole = fill(template, values);
  if (whole.length <= HEADER_MAX) return whole;
  const room = Math.max(10, values.subject.length - (whole.length - HEADER_MAX));
  const cut = values.subject.slice(0, room).replace(/\s+\S*$/, "");
  return fill(template, { ...values, subject: cut || values.subject.slice(0, room) });
}

/** The trailers: `Jarvis-Run` always (`jarvis explain` follows it), `Assisted-By` unless off. */
export function trailersOf(cfg: DeliveryConfig, runId: string): string {
  const lines = [`Jarvis-Run: ${runId}`];
  if (cfg.assistedBy !== false)
    lines.push(`Assisted-By: ${cfg.assistedBy.replaceAll("{version}", packageInfo().version)}`);
  return lines.join("\n");
}

/** The PR's commit message: the header by `commit.format`, then the trailers. */
export function commitMessageOf(cfg: DeliveryConfig, input: FormatInput): string {
  return `${headerOf(cfg, input, cfg.commit.format)}\n\n${trailersOf(cfg, input.runId)}`;
}

/** The branch pushed: `delivery.branch` filled, else undefined (the run's own branch). */
export function branchOf(cfg: DeliveryConfig, input: FormatInput): string | undefined {
  if (!cfg.branch) return undefined;
  const values = valuesOf(cfg, input, cfg.branch);
  const sep = /_\{slug\}/.test(cfg.branch) ? "_" : "-";
  const filled = cfg.branch.replace(/\{(\w+)\}/g, (_, name: string) =>
    name === "slug" ? slugOf(values.subject, 40, sep) : ((values as Record<string, string>)[name] ?? ""),
  );
  // what git refuses in a branch name
  return filled
    .replace(/\s+/g, "-")
    .replace(/[~^:?*[\\\]]+/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/[-_/.]+$/, "");
}
