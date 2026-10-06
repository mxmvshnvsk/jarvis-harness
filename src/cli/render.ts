import type { Style } from "./style.ts";

/**
 * Light rendering of the two kinds of text the CLI shows verbatim: markdown documents (a
 * candidate's proposal, an answer) and unified diffs. Plain style returns the text unchanged.
 */

/** Headings bold, front matter and rules dim, `code` as commands, `**[check: …]**` markers yellow. */
export function renderMarkdown(text: string, style: Style): string {
  if (!style.enabled) return text;
  const lines = text.split("\n");
  let front = lines[0] === "---";
  let fence = false;
  return lines
    .map((line, i) => {
      if (front) {
        if (i > 0 && line === "---") front = false;
        return style.muted(line);
      }
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        return style.muted(line);
      }
      if (fence) return line;
      if (/^#{1,6}\s/.test(line)) return style.heading(line.replace(/^#{1,6}\s+/, (h) => style.muted(h)));
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return style.muted(line);
      return style
        .inline(line)
        .replace(/\*\*\[check:[^\]]*\]\*\*/g, (m) => style.warn(m.slice(2, -2)))
        .replace(/\*\*([^*\n]+)\*\*/g, (_m, b: string) => style.heading(b))
        .replace(
          /^(\s*)([-*]|\d+\.)(\s)/,
          (_m, a: string, b: string, c: string) => `${a}${style.muted(b)}${c}`,
        );
    })
    .join("\n");
}

/** git's colours: file headers bold, hunk headers cyan, additions green, removals red. */
export function renderDiff(text: string, style: Style): string {
  if (!style.enabled) return text;
  return text
    .split("\n")
    .map((line) => {
      if (
        /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(
          line,
        )
      )
        return style.heading(line);
      if (line.startsWith("@@")) return line.replace(/^@@[^@]*@@/, (h) => style.cmd(h));
      if (line.startsWith("+")) return style.add(line);
      if (line.startsWith("-")) return style.del(line);
      return line;
    })
    .join("\n");
}

const SKIP_KEYS = new Set(["$schema", "outcome", "title", "summary", "sources"]);

/** `openQuestions` → `Open questions`. */
function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function scalar(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function itemLines(item: unknown, indent: string): string[] {
  const s = scalar(item);
  if (s !== undefined) return [`${indent}- ${s}`];
  if (Array.isArray(item)) return item.flatMap((i) => itemLines(i, indent));
  if (!item || typeof item !== "object") return [];
  const o = item as Record<string, unknown>;
  // the line: `**id** text` (requirements), else the first text-like field
  const id = scalar(o.id);
  const headKey = [
    "text",
    "title",
    "summary",
    "detail",
    "topic",
    "path",
    "name",
    "issue",
    "description",
  ].find((k) => scalar(o[k]) !== undefined);
  const head = [id ? `**${id}**` : "", headKey ? (scalar(o[headKey]) as string) : ""]
    .filter(Boolean)
    .join(" ");
  const lines = [`${indent}- ${head || "—"}`];
  for (const [k, v] of Object.entries(o)) {
    if (k === "id" || k === headKey || v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    const sv = scalar(v);
    if (sv !== undefined) lines.push(`${indent}  - ${humanize(k)}: ${sv}`);
    else if (Array.isArray(v) && v.length === 1 && scalar(v[0]) !== undefined)
      lines.push(`${indent}  - ${humanize(k)}: ${scalar(v[0])}`);
    else {
      lines.push(`${indent}  - ${humanize(k)}:`);
      lines.push(...itemLines(v, `${indent}    `));
    }
  }
  return lines;
}

/**
 * An agent's result document (spec, requirements, research — JSON by schema) as markdown to read:
 * title and summary first, every other field as a section, sources last. Pilot: `jarvis show <run>
 * spec` printed 9 KB of JSON for a person asked to approve it.
 */
export function documentToMarkdown(doc: Record<string, unknown>): string {
  const out: string[] = [];
  const title = scalar(doc.title);
  if (title) out.push(`# ${title}`, "");
  const summary = scalar(doc.summary);
  if (summary) out.push(summary, "");
  for (const [key, value] of Object.entries(doc)) {
    if (SKIP_KEYS.has(key) || value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out.push(`## ${humanize(key)}`, "");
    const s = scalar(value);
    if (s !== undefined) out.push(s);
    else out.push(...itemLines(value, ""));
    out.push("");
  }
  const outcome = scalar(doc.outcome);
  if (outcome && outcome !== "ok") out.push(`**Outcome:** ${outcome}`, "");
  if (Array.isArray(doc.sources) && doc.sources.length > 0) {
    out.push("## Sources", "", ...doc.sources.map((x) => `- \`${String(x)}\``), "");
  }
  return out.join("\n").trimEnd();
}
