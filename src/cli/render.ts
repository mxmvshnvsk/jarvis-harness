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
