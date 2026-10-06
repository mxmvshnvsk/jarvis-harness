/**
 * HTML for `jarvis ui` (ADR-0023 §5): every value goes through `html`, which escapes it unless it is
 * markup built here (`Html`). Agents write the documents and the diff is code from the run: nothing
 * of theirs reaches the page as markup — a `<script>` in a spec is shown as text.
 */
export class Html {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

export type Part = Html | string | number | boolean | null | undefined | readonly Part[];

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

function render(part: Part): string {
  if (part instanceof Html) return part.value;
  if (part === null || part === undefined || part === false) return "";
  if (Array.isArray(part)) return part.map((p) => render(p)).join("");
  return escapeHtml(String(part));
}

/** html`<p>${text}</p>`: interpolated values are escaped; `Html` and arrays of it are kept. */
export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

/** Markup that is already safe (built by this module from escaped parts). */
export function raw(markup: string): Html {
  return new Html(markup);
}

export function join(parts: readonly Part[], separator: Part = ""): Html {
  const sep = render(separator);
  return new Html(parts.map((p) => render(p)).join(sep));
}

/* ---- markdown ---- */

/** Inline markdown of an escaped line: `code`, **bold**, *italic*, http(s) links; nothing else. */
function inline(text: string): string {
  const codes: string[] = [];
  // code spans first: their content is literal
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*\[check:([^\]]*)\]\*\*/g, (_m, c: string) => `<mark>check:${c}</mark>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    // only http(s): a `javascript:` link stays text
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g,
      (_m, label: string, url: string) => `<a href="${url}" rel="noreferrer noopener">${label}</a>`,
    );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the placeholder of a code span
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "");
}

interface ListFrame {
  readonly indent: number;
  readonly tag: "ul" | "ol";
}

/**
 * A small markdown renderer for documents agents write and `documentToMarkdown` produces: headings,
 * paragraphs, nested lists, fenced code, quotes, rules, pipe tables. Escapes first, then marks up.
 */
export function markdownToHtml(text: string, options: { readonly shift?: number } = {}): Html {
  const shift = options.shift ?? 1;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const lists: ListFrame[] = [];
  let paragraph: string[] = [];
  let i = 0;
  const flush = () => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeLists = (to = 0) => {
    while (lists.length > to) out.push(`</li></${lists.pop()?.tag}>`);
  };
  // YAML front matter: shown as code, as the terminal dims it
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      out.push(`<pre class="front">${escapeHtml(lines.slice(1, end).join("\n"))}</pre>`);
      i = end + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      closeLists();
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] as string).trim().startsWith(fence[1] as string); i++)
        body.push(lines[i] as string);
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      closeLists();
      // the page has its own h1: a document's `#` is an h2 (`shift` 0: its title was taken out)
      const level = Math.max(2, Math.min(6, (heading[1] as string).length + shift));
      out.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flush();
      closeLists();
      out.push("<hr>");
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const indent = (item[1] as string).length;
      const tag = /\d/.test(item[2] as string) ? "ol" : "ul";
      while (lists.length > 0 && (lists.at(-1) as ListFrame).indent > indent) closeLists(lists.length - 1);
      const top = lists.at(-1);
      if (!top || indent > top.indent) {
        lists.push({ indent, tag });
        out.push(`<${tag}><li>`);
      } else out.push("</li><li>");
      out.push(inline(item[3] as string));
      continue;
    }
    if (lists.length > 0 && /^\s+\S/.test(line)) {
      // a continuation line of a list item
      out.push(` ${inline(line.trim())}`);
      continue;
    }
    closeLists();
    if (line.startsWith(">")) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && (lines[i] as string).startsWith(">"); i++)
        quote.push((lines[i] as string).replace(/^>\s?/, ""));
      i--;
      out.push(`<blockquote>${markdownToHtml(quote.join("\n")).value}</blockquote>`);
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? "")) {
      flush();
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => inline(c.trim()));
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && (lines[i] as string).trim().startsWith("|"); i++)
        rows.push(cells(lines[i] as string));
      i--;
      out.push(
        `<div class="scroll"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  closeLists();
  return new Html(out.join("\n"));
}

/* ---- diffs ---- */

export interface DiffLine {
  readonly kind: "context" | "add" | "del" | "hunk" | "note";
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface DiffFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: "added" | "deleted" | "modified" | "renamed" | "binary";
  readonly added: number;
  readonly removed: number;
  readonly lines: readonly DiffLine[];
}

/** `git diff` output as files of numbered lines (both sides), hunk headers kept. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  type Draft = {
    path: string;
    oldPath?: string;
    status: DiffFile["status"];
    added: number;
    removed: number;
    lines: DiffLine[];
  };
  let file: Draft | undefined;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const close = () => {
    if (file) files.push({ ...file });
  };
  for (const line of text.split("\n")) {
    const start = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (start) {
      close();
      file = { path: start[2] as string, status: "modified", added: 0, removed: 0, lines: [] };
      if (start[1] !== start[2]) file.oldPath = start[1] as string;
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (line.startsWith("new file")) file.status = "added";
      else if (line.startsWith("deleted file")) file.status = "deleted";
      else if (line.startsWith("rename from")) file.status = "renamed";
      else if (line.startsWith("Binary files")) {
        file.status = "binary";
        file.lines.push({ kind: "note", text: "binary file" });
      } else if (line.startsWith("+++ ") && line !== "+++ /dev/null")
        file.path = line.replace(/^\+\+\+ b\//, "");
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      file.lines.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      file.added += 1;
      file.lines.push({ kind: "add", text: line.slice(1), newLine: newNo++ });
    } else if (line.startsWith("-")) {
      file.removed += 1;
      file.lines.push({ kind: "del", text: line.slice(1), oldLine: oldNo++ });
    } else if (line.startsWith(" ")) {
      file.lines.push({ kind: "context", text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
    } else if (line.startsWith("\\")) {
      file.lines.push({ kind: "note", text: line.slice(2) });
    }
  }
  close();
  return files;
}
