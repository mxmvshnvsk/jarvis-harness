import { parse } from "yaml";

export interface FrontMatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
}

/** Splits `---\nyaml\n---\nbody`. A file without front matter has empty data. */
export function parseFrontMatter(text: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };
  const parsed: unknown = parse(match[1] as string);
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { data, body: match[2] ?? "" };
}

/** Minimal glob → RegExp: `**` any path, `*` within a segment, `?` one char, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function globMatches(path: string, globs: readonly string[]): boolean {
  const normalized = path.split("\\").join("/");
  return globs.some((g) => globToRegExp(g).test(normalized));
}
