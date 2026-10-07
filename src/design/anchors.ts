/**
 * Anchors: the names and interface texts the task's sources mention (`isExpressDelivery`, «Delivery window»),
 * found in the code by code before the agents. Pilot: every research run began with the same searches
 * for exactly these — a few model calls of a dozen seconds each, for what a search answers.
 */

export interface Anchor {
  readonly kind: "name" | "text";
  readonly value: string;
}

export interface AnchorHit {
  readonly anchor: Anchor;
  /** `path:line`, at most a few per anchor. */
  readonly places: readonly string[];
  /** All hits, when there were more than shown. */
  readonly total: number;
  readonly files: number;
}

export const ANCHOR_LIMITS = { names: 15, texts: 10, places: 8, common: { hits: 60, files: 20 } } as const;

/** Names that look like code but are products and brands. */
const NOT_CODE = new Set(
  "JavaScript TypeScript GitHub GitLab YouTube PostgreSQL WhatsApp LinkedIn iPhone iPad macOS iOS OpenAPI GraphQL WebSocket DevTools PowerPoint SharePoint".split(
    " ",
  ),
);

/**
 * camelCase (`isExpressDelivery`, at least 6 chars), PascalCase with two humps (`DeliverySlotCode`, at least 8)
 * and UPPER_SNAKE (`DELIVERY_SLOT`) from the texts; the keys of JSON the tools answered with (`"createdAt":`)
 * and links are not anchors.
 */
export function anchorsIn(texts: readonly string[]): Anchor[] {
  const names: string[] = [];
  const quoted: string[] = [];
  for (const raw of texts) {
    const keys = new Set([...raw.matchAll(/"([A-Za-z_][\w]*)"\s*:/g)].map((m) => m[1] as string));
    // values of that JSON (`"summary": "…"`) are fields, not texts in quotes
    const values = new Set(
      [...raw.matchAll(/"[A-Za-z_][\w]*"\s*:\s*"((?:[^"\\]|\\.){3,80})"/g)].map((m) =>
        (m[1] as string).replace(/\s+/g, " ").trim(),
      ),
    );
    // the tools answer with JSON: a page's text has its quotes and line breaks escaped (`\"`, `\n`), and
    // non-breaking spaces where the code has plain ones
    const text = raw
      .replace(/\\+n/g, "\n")
      .replace(/\\+[rt]/g, " ")
      .replace(/\\+"/g, '"')
      .replace(/\u00a0|&nbsp;/g, " ")
      .replace(/https?:\/\/\S+/g, " ");
    for (const m of text.matchAll(
      /(?<![\w./-])([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![\w/-])/g,
    )) {
      const name = m[1] as string;
      const camel = /^[a-z]/.test(name);
      const snake = name.includes("_");
      if (keys.has(name) || NOT_CODE.has(name)) continue;
      if (camel ? name.length < 6 : snake ? !/^[A-Z]{2,}(?:_[A-Z][A-Z0-9]+)+$/.test(name) : name.length < 8)
        continue;
      if (!names.includes(name)) names.push(name);
    }
    for (const m of text.matchAll(/[«“]([^«»“”\n]{3,80})[»”]|"([^"\n]{3,80})"/g)) {
      const plain = m[2] !== undefined;
      const t = ((m[1] ?? m[2]) as string).replace(/\s+/g, " ").trim();
      // a title of a page or an issue (`… | FRONT`) is not an interface text
      if (!/\p{L}/u.test(t) || t.includes("|") || t.split(" ").length > 8) continue;
      // in plain quotes only what reads as words: not a JSON value, an attribute or a path
      if (
        plain &&
        (values.has(t) || !/[\s\u0400-\u04FF]/.test(t) || /[=<>/:{}\\]/.test(t) || /^[\w.-]+$/.test(t))
      )
        continue;
      if (!quoted.includes(t)) quoted.push(t);
    }
  }
  return [
    ...names.slice(0, ANCHOR_LIMITS.names).map((value) => ({ kind: "name" as const, value })),
    ...quoted.slice(0, ANCHOR_LIMITS.texts).map((value) => ({ kind: "text" as const, value })),
  ];
}

/** `path:line:text` lines of a search → where, without the knowledge and config of Jarvis itself. */
export function hitOf(anchor: Anchor, lines: readonly string[]): AnchorHit {
  const found = lines
    .map((l) => /^(.+?):(\d+):/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && !(m[1] as string).startsWith(".jarvis/"));
  // one entry per file with its lines: `src/a.ts:12,40`
  const byFile = new Map<string, string[]>();
  for (const m of found) byFile.set(m[1] as string, [...(byFile.get(m[1] as string) ?? []), m[2] as string]);
  const common = found.length > ANCHOR_LIMITS.common.hits || byFile.size > ANCHOR_LIMITS.common.files;
  return {
    anchor,
    places: common
      ? []
      : [...byFile.entries()]
          .slice(0, ANCHOR_LIMITS.places)
          .map(([f, ls]) => `${f}:${ls.slice(0, 5).join(",")}`),
    total: found.length,
    files: byFile.size,
  };
}

/** The section of `sources.md`: where each name and text is, and what the code does not have yet. */
export function anchorsSection(hits: readonly AnchorHit[]): string {
  const label = (a: Anchor) => (a.kind === "name" ? `\`${a.value}\`` : `«${a.value}»`);
  return [
    "## Where the sources' names and texts are in the code",
    "",
    "Searched by Jarvis without a model: the code names and the quoted interface texts of the task, its issues and pages, each as a literal string. Start from these places and read them; search again only for what is not here. Not in the code means new to it, or worded otherwise there.",
    "",
    ...hits.map((h) =>
      h.total === 0
        ? `- ${label(h.anchor)} — not in the code`
        : h.places.length === 0
          ? `- ${label(h.anchor)} — everywhere (${h.total} in ${h.files} files): too common to point at`
          : `- ${label(h.anchor)} — ${h.places.join("; ")}${h.files > h.places.length ? `; ${h.files - h.places.length} more file${h.files - h.places.length === 1 ? "" : "s"}` : ""}`,
    ),
  ].join("\n");
}
