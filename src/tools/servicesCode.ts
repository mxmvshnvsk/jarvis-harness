import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { layoutOf } from "../core/paths.ts";
import { serviceCodeRoots } from "../knowledge/glossaries.ts";
import { git } from "./local/exec.ts";
import type { Capability, ToolContext, ToolOutput, ToolProvider } from "./types.ts";

/**
 * The services' code from a knowledge repository (ADR-0025 §6): a task across services works in the
 * knowledge repository, which has no code — its research grepped the services' documents for a flag's
 * name in eleven spellings and asked for more calls twice (pilot). The services' clones on this
 * machine (`services.<name>.repo` of the map) are searched and read as they are checked out: read only,
 * never written; a service not cloned here is said to be so.
 */
export const SERVICES_CODE = ["services.search", "services.read"] as const;

/** The knowledge repository itself (not a service's run): where these tools mean something. */
export function servesServicesCode(root: string): boolean {
  const meta = layoutOf(root).meta;
  return Boolean(meta && !meta.service);
}

const MAX_LINE = 300;
const READ_MAX = 400;
/**
 * Reads of the services' code in one step: the master maps the task onto services and their contract;
 * each subtask's research reads its own code. Pilot: a master's research read 156 places in the
 * services' code — the hashing, the e-mails, the controllers, their tests — and ran to 270 calls.
 */
export const SERVICES_READS = 30;

/** What a step read of each file: its line ranges (the places counted against SERVICES_READS). */
const shown = new Map<string, Map<string, Array<[number, number]>>>();
const stepOf = (ctx: ToolContext) => `${ctx.run.id}:${ctx.stepId}:${ctx.iteration}`;

function cloned(ctx: ToolContext): Record<string, string> | ToolOutput {
  if (!servesServicesCode(ctx.workspacePath))
    return { ok: false, error: "only in a task across services, from the knowledge repository" };
  const codes = serviceCodeRoots(ctx.workspacePath);
  if (Object.keys(codes).length === 0)
    return { ok: false, error: "no service of the map is cloned on this machine (services.<name>.repo)" };
  return codes;
}

const isOutput = (x: unknown): x is ToolOutput => typeof (x as ToolOutput).ok === "boolean";

const names = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
    .map((x) => String(x).trim())
    .filter(Boolean);

export class ServicesCodeProvider implements ToolProvider {
  readonly name = "services";

  capabilities(): readonly Capability[] {
    return [
      {
        name: "services.search",
        description:
          "Search the code of the map's services (their clones on this machine, as checked out): a regex (`(?i)` at the start for any case) or literal=true. `services` narrows it to some, `glob` to files (`*.ts`). Hits come as `<service>:<path>:<line>:<text>`; read one with services.read.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            services: { type: "array", items: { type: "string" } },
            glob: { type: "string" },
            literal: { type: "boolean" },
            maxResults: { type: "integer" },
          },
          required: ["pattern"],
        },
        handler: async (args, ctx) => {
          const codes = cloned(ctx);
          if (isOutput(codes)) return codes;
          let pattern = String(args.pattern ?? "").trim();
          if (!pattern) return { ok: false, error: "say the pattern" };
          const ignoreCase = /^\(\?i\)/.test(pattern);
          pattern = pattern.replace(/^\(\?i\)/, "");
          const wanted = names(args.services);
          const unknown = wanted.filter((s) => !codes[s]);
          const which = wanted.length > 0 ? wanted.filter((s) => codes[s]) : Object.keys(codes).sort();
          const max = Math.min(Math.max(Number(args.maxResults) || 80, 1), 300);
          const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;
          const per = await Promise.all(
            which.map(async (service) => {
              const r = await git(
                [
                  "grep",
                  "-n",
                  "-I",
                  ...(ignoreCase ? ["-i"] : []),
                  args.literal === true ? "-F" : "-E",
                  "-e",
                  pattern,
                  "--",
                  ...(glob ? [glob.includes("/") ? glob : `**/${glob}`] : ["."]),
                ],
                codes[service] as string,
                { timeoutMs: 60_000 },
              );
              if (r.code !== 0 && r.code !== 1)
                return { service, error: r.stderr.trim() || `git grep ${r.code}` };
              const hits = r.stdout
                .split("\n")
                .filter(Boolean)
                .filter((l) => !ctx.pathPolicy.isDenied(l.split(":")[0] ?? ""))
                .map((l) => `${service}:${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l}`);
              return { service, hits };
            }),
          );
          const errors = per.flatMap((p) => ("error" in p ? [`${p.service}: ${p.error}`] : []));
          const all = per.flatMap((p) => ("hits" in p ? (p.hits ?? []) : []));
          const counts = per
            .filter((p) => "hits" in p && (p.hits ?? []).length > 0)
            .map((p) => `${p.service} ${"hits" in p ? (p.hits ?? []).length : 0}`);
          const text = [
            all.length === 0
              ? `nothing in ${which.length} service(s)`
              : `${all.length} hit(s): ${counts.join(", ")}${all.length > max ? ` — the first ${max}` : ""}`,
            ...all.slice(0, max),
            ...(unknown.length > 0 ? [`not cloned here or not of the map: ${unknown.join(", ")}`] : []),
            ...(errors.length > 0 ? [`failed: ${errors.join("; ")}`] : []),
          ].join("\n");
          return { ok: true, text, data: { matches: all.length, services: which.length } };
        },
      },
      {
        name: "services.read",
        description:
          "Read a file of a service of the map (its clone on this machine): service, path as services.search gives it, startLine/endLine (up to 400 lines at once).",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: {
            service: { type: "string" },
            path: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
          },
          required: ["service", "path"],
        },
        handler: async (args, ctx) => {
          const codes = cloned(ctx);
          if (isOutput(codes)) return codes;
          const service = String(args.service ?? "").trim();
          const repo = codes[service];
          if (!repo) return { ok: false, error: `${service || "?"} is not cloned here or not of the map` };
          const rel = normalize(String(args.path ?? "")).replace(/^[/\\]+/, "");
          if (!rel || rel.startsWith("..") || isAbsolute(rel) || ctx.pathPolicy.isDenied(rel))
            return { ok: false, error: `not a path of ${service}: ${String(args.path)}` };
          const file = join(repo, rel);
          if (!existsSync(file)) return { ok: false, error: `${service} has no ${rel}` };
          const lines = readFileSync(file, "utf8").split("\n");
          const from = Math.max(1, Number(args.startLine) || 1);
          const to = Math.min(lines.length, Number(args.endLine) || from + READ_MAX - 1, from + READ_MAX - 1);
          const step = shown.get(stepOf(ctx)) ?? new Map<string, Array<[number, number]>>();
          shown.set(stepOf(ctx), step);
          // the steps of long ago are of no use: the map keeps the latest few
          if (shown.size > 64) shown.delete(shown.keys().next().value as string);
          const key = `${service}:${rel}`;
          const ranges = step.get(key) ?? [];
          const again = ranges.some(([a, b]) => a <= from && to <= b);
          const reads = [...step.values()].reduce((n, r) => n + r.length, 0);
          if (!again && reads >= SERVICES_READS)
            return {
              ok: true,
              text: `${SERVICES_READS} places of the services' code read in this step: enough to say which service changes where. Name the place (${key}) in your result — the subtask's own research reads it — and finish.`,
              data: { service, path: rel, capped: true },
            };
          // the same lines again (their first answer may have been trimmed): read, not counted again
          if (!again) step.set(key, [...ranges, [from, to]]);
          const body = lines
            .slice(from - 1, to)
            .map((l, i) => `${from + i}: ${l}`)
            .join("\n");
          const more = to < lines.length ? `\n(lines ${to + 1}–${lines.length} not shown)` : "";
          return {
            ok: true,
            text: `${service}:${rel} (${lines.length} lines)\n${body}${more}`,
            data: { service, path: rel, lines: lines.length, from, to },
          };
        },
      },
    ];
  }
}
