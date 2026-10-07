/**
 * A Figma frame read by code, not by a model (pilot: "the document is almost always the same JSON").
 * `figma-developer-mcp` with OUTPUT_FORMAT=json answers `get_figma_data` with a SimplifiedDesign: a
 * tree of nodes and dictionaries of components, component sets, styles and element templates. This
 * turns it into a short description an agent reads at a glance — the texts in order with their style
 * and colour, the layout tree with gaps and paddings, the design-system components with their
 * properties, and the spacing and colours used — so the model spends itself on what the design means.
 */

type Style = Record<string, unknown> | unknown[] | string;

export interface FigmaNode {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  readonly template?: string;
  readonly text?: string;
  readonly textStyle?: string | Record<string, unknown>;
  readonly fills?: string | unknown[];
  /** A style key, or the stroke itself: `{ colors, strokeWeight, strokeDashes }` or a list of paints. */
  readonly strokes?: string | unknown[] | Record<string, unknown>;
  readonly strokeWeight?: string | number;
  readonly strokeWeights?: string;
  readonly strokeDashes?: readonly number[];
  readonly borderRadius?: string;
  readonly opacity?: number;
  readonly layout?: string | Record<string, unknown>;
  readonly componentId?: string;
  readonly componentProperties?: Record<string, boolean | string>;
  readonly children?: readonly FigmaNode[];
}

type Components = Record<string, { name: string; componentSetId?: string }>;
type ComponentSets = Record<string, { name: string; description?: string }>;

export interface FigmaDesign {
  /** The server's answer puts the name and the dictionaries in `metadata`; its types say top level. */
  readonly name?: string;
  readonly metadata?: { name?: string; components?: Components; componentSets?: ComponentSets };
  readonly nodes: readonly FigmaNode[];
  readonly components?: Components;
  readonly componentSets?: ComponentSets;
  readonly globalVars?: { styles?: Record<string, Style> };
  readonly elements?: Record<string, Omit<FigmaNode, "id" | "name" | "children" | "template">>;
}

/** The answer of get_figma_data in JSON; undefined for the tree or YAML formats. */
export function parseFigmaDesign(text: string): FigmaDesign | undefined {
  const body = text.trim();
  if (!body.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(body) as Partial<FigmaDesign>;
    return Array.isArray(value.nodes) ? (value as FigmaDesign) : undefined;
  } catch {
    return undefined;
  }
}

/** Generated keys (`fill_97D170E1`, `style_1A2B3C`) are not names a person gave. */
const GENERATED = /^[a-z]+_[A-Za-z0-9]{6,}$/;

export interface DescribeOptions {
  /** Lines of the layout tree at most; the texts and the summaries are always whole. */
  readonly maxTreeLines?: number;
  readonly link?: string;
}

export interface FrameDescription {
  readonly text: string;
  readonly texts: number;
  readonly components: readonly string[];
}

export function describeFrame(design: FigmaDesign, options: DescribeOptions = {}): FrameDescription {
  const styles = design.globalVars?.styles ?? {};
  const fileName = design.metadata?.name ?? design.name ?? "?";
  const components = design.metadata?.components ?? design.components ?? {};
  const componentSets = design.metadata?.componentSets ?? design.componentSets ?? {};
  const resolve = <T>(v: T | string | undefined): { value: T | undefined; name?: string } => {
    if (typeof v !== "string") return { value: v };
    const found = styles[v];
    if (found === undefined) return { value: undefined, name: v };
    return { value: found as T, ...(GENERATED.test(v) ? {} : { name: v }) };
  };
  const expand = (n: FigmaNode): FigmaNode =>
    n.template && design.elements?.[n.template] ? { ...design.elements[n.template], ...n } : n;

  const colorOf = (fills: string | unknown[] | undefined): string | undefined => {
    const { value } = resolve<unknown[]>(fills);
    const first = Array.isArray(value) ? value[0] : undefined;
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "type" in first)
      return String((first as { type: unknown }).type).toLowerCase();
    return undefined;
  };
  const paintOf = (p: unknown): string | undefined => {
    if (typeof p === "string") return p;
    if (p && typeof p === "object") {
      const o = p as { hex?: unknown; opacity?: unknown; type?: unknown };
      if (typeof o.hex === "string")
        return typeof o.opacity === "number" && o.opacity < 1
          ? `${o.hex} ${Math.round(o.opacity * 100)}%`
          : o.hex;
      if (o.type !== undefined) return String(o.type).toLowerCase();
    }
    return undefined;
  };
  /**
   * A border or a divider line: weight per side, colour, dashes. The server keeps it as a style
   * (`stroke_…`: colours, strokeWeight — `1px` or `0px 0px 1px 0px` per side — and strokeDashes) or
   * on the node; pilot: the line under a modal's header read as a frame "?×0" without it.
   */
  const strokeOf = (n: FigmaNode): { text: string; color?: string } | undefined => {
    const { value } = resolve<unknown>(n.strokes as string | undefined);
    const v = (n.strokes !== undefined && typeof n.strokes !== "string" ? n.strokes : value) as unknown;
    const obj = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    const paints = Array.isArray(v) ? v : Array.isArray(obj.colors) ? (obj.colors as unknown[]) : [];
    const color = paintOf(paints[0]);
    if (!color) return undefined;
    const rawWeight = obj.strokeWeights ?? obj.strokeWeight ?? n.strokeWeights ?? n.strokeWeight;
    const weight =
      typeof rawWeight === "number" ? `${rawWeight}px` : typeof rawWeight === "string" ? rawWeight : "1px";
    const dashes = (obj.strokeDashes ?? n.strokeDashes) as unknown;
    const dashed = Array.isArray(dashes) && dashes.length > 0 ? " dashed" : "";
    // `top right bottom left` (or its CSS shorthands): name the sides that have a line
    const parts = weight.trim().split(/\s+/);
    const sides =
      parts.length === 4
        ? (parts as [string, string, string, string])
        : parts.length === 3
          ? ([parts[0], parts[1], parts[2], parts[1]] as [string, string, string, string])
          : parts.length === 2
            ? ([parts[0], parts[1], parts[0], parts[1]] as [string, string, string, string])
            : undefined;
    const zero = (w: string) => /^0(px)?$/.test(w);
    if (sides && new Set(sides).size > 1) {
      const named = (["top", "right", "bottom", "left"] as const)
        .map((side, i) => (zero(sides[i] as string) ? "" : `${side} ${sides[i]}`))
        .filter(Boolean);
      if (named.length === 0) return undefined;
      return { text: `border-${named.join(" ")}${dashed} ${color}`, color };
    }
    const w = sides ? sides[0] : weight;
    if (zero(w)) return undefined;
    return { text: `border ${w}${dashed} ${color}`, color };
  };
  const textStyleOf = (s: FigmaNode["textStyle"]): string | undefined => {
    const { value, name } = resolve<Record<string, unknown>>(s);
    const v = value ?? {};
    const size =
      v.fontSize !== undefined
        ? `${v.fontSize}${v.lineHeight ? `/${String(v.lineHeight).replace(/px$/, "")}` : ""}`
        : "";
    const weight = v.fontWeight !== undefined ? ` ${v.fontWeight}` : "";
    const metrics = `${size}${weight}`.trim();
    if (name && metrics) return `${name} (${metrics})`;
    return name ?? (metrics || undefined);
  };
  const componentOf = (n: FigmaNode): string | undefined => {
    if (!n.componentId) return undefined;
    const c = components[n.componentId];
    if (!c) return undefined;
    const set = c.componentSetId ? componentSets[c.componentSetId]?.name : undefined;
    return set ? `${set} (${c.name})` : c.name;
  };
  const props = (p: FigmaNode["componentProperties"]): string =>
    p && Object.keys(p).length > 0
      ? Object.entries(p)
          .map(
            ([k, v]) =>
              `${k.replace(/^[^\p{L}\p{N}]+/u, "").trim()}=${typeof v === "string" ? JSON.stringify(v) : v}`,
          )
          .join(", ")
      : "";

  const gaps = new Map<string, number>();
  const paddings = new Map<string, number>();
  const colors = new Map<string, number>();
  const used = new Map<string, number>();
  const texts: string[] = [];
  const tree: string[] = [];
  const max = options.maxTreeLines ?? 160;
  let cut = 0;
  const count = (m: Map<string, number>, k: string | undefined) => {
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  };

  const layoutOf = (n: FigmaNode): string => {
    const { value: l } = resolve<Record<string, unknown>>(n.layout);
    if (!l) return "";
    const parts: string[] = [];
    if (l.mode === "row" || l.mode === "column" || l.mode === "grid") parts.push(String(l.mode));
    if (typeof l.gap === "string") {
      parts.push(`gap ${l.gap}`);
      count(gaps, l.gap);
    }
    if (typeof l.padding === "string") {
      parts.push(`padding ${l.padding}`);
      count(paddings, l.padding);
    }
    if (l.justifyContent && l.justifyContent !== "flex-start") parts.push(`justify ${l.justifyContent}`);
    if (l.alignItems && l.alignItems !== "flex-start") parts.push(`align ${l.alignItems}`);
    const d = l.dimensions as { width?: number; height?: number } | undefined;
    const s = l.sizing as { horizontal?: string; vertical?: string } | undefined;
    if (d?.width !== undefined || d?.height !== undefined) parts.push(`${d.width ?? "?"}×${d.height ?? "?"}`);
    else if (s?.horizontal || s?.vertical) parts.push(`${s.horizontal ?? "-"}/${s.vertical ?? "-"}`);
    return parts.join(", ");
  };

  const walk = (raw: FigmaNode, depth: number) => {
    const n = expand(raw);
    const type = (n.type ?? "").toUpperCase();
    const component = componentOf(n);
    if (component) count(used, component.replace(/ \(.*\)$/, ""));
    const color = colorOf(n.fills);
    const isText = type === "TEXT" || n.text !== undefined;
    if (isText) count(colors, color);
    else if (color && color !== "#FFFFFF" && color !== "#ffffff") count(colors, color);
    const textStyle = isText ? textStyleOf(n.textStyle) : undefined;
    if (isText && n.text)
      texts.push(
        `- «${n.text.replace(/\s+/g, " ").trim()}»${textStyle ? ` — ${textStyle}` : ""}${color ? `, ${color}` : ""}`,
      );
    const label = component
      ? `${component}${props(n.componentProperties) ? ` · ${props(n.componentProperties)}` : ""}`
      : isText
        ? `text «${(n.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80)}»${textStyle ? ` · ${textStyle}` : ""}`
        : `${type.toLowerCase() || "node"}${n.name ? ` "${n.name}"` : ""}`;
    const stroke = isText ? undefined : strokeOf(n);
    if (stroke?.color) count(colors, `${stroke.color} (line)`);
    let layout = isText ? "" : layoutOf(n);
    // a frame with no height (or width) drawn by its stroke is a line: say so, not "?×0"
    const flat = /(^|, )(\?|\d+)×0$|(^|, )0×(\?|\d+)$/.test(layout);
    if (stroke && flat) layout = layout.replace(/(, )?(\?|\d+)×0$|(, )?0×(\?|\d+)$/, "");
    const extra = [
      stroke && flat ? `divider: ${stroke.text.replace(/^border(-\w+)? /, "")}` : "",
      layout,
      !isText && color ? `bg ${color}` : "",
      stroke && !flat ? stroke.text : "",
      n.borderRadius ? `radius ${n.borderRadius}` : "",
      n.opacity !== undefined && n.opacity < 1 ? `opacity ${n.opacity}` : "",
    ].filter(Boolean);
    if (tree.length < max)
      tree.push(`${"  ".repeat(depth)}- ${label}${extra.length > 0 ? ` — ${extra.join(", ")}` : ""}`);
    else cut += 1;
    // an icon or a vector drawing has no structure worth a line per path
    if (type === "IMAGE-SVG" || type === "VECTOR" || type === "BOOLEAN_OPERATION") return;
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  for (const n of design.nodes) walk(n, 0);

  const top = design.nodes[0];
  const title = top ? (componentOf(expand(top)) ?? top.name ?? top.id) : fileName;
  const sorted = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}${v > 1 ? ` ×${v}` : ""}`);
  const lines = [
    `### ${title}`,
    `Figma: ${fileName}${top ? ` · node ${top.id}` : ""}${options.link ? ` · ${options.link}` : ""}`,
    "",
    "Texts, in order:",
    ...(texts.length > 0 ? texts : ["- (none)"]),
    "",
    "Layout:",
    ...tree,
    ...(cut > 0
      ? [`- … ${cut} more nodes (read the frame's children by their own links, or figma.get with raw: true)`]
      : []),
    "",
    `Design-system components: ${sorted(used).join("; ") || "none"}`,
    `Gaps: ${sorted(gaps).join(", ") || "none"} · paddings: ${sorted(paddings).join(", ") || "none"}`,
    `Colours (for meaning, not to copy): ${sorted(colors).join(", ") || "none"}`,
  ];
  return { text: lines.join("\n"), texts: texts.length, components: [...used.keys()] };
}

/** Frame links in a text — a plain link, an "Embedded on the page" line — deduplicated by file and node. */
export function figmaLinksIn(text: string): string[] {
  const out = new Map<string, string>();
  for (const m of text.matchAll(
    /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\/[A-Za-z0-9]+[^\s)\]"'<>|`]*/g,
  )) {
    const link = m[0].replace(/[.,;]+$/, "");
    const key = /\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/.exec(link)?.[1];
    const node = /[?&]node-id=([0-9]+[-:][0-9]+)/.exec(link)?.[1]?.replace(":", "-");
    if (!key || !node) continue; // a whole file is not a frame
    const id = `${key}:${node}`;
    if (!out.has(id)) out.set(id, link);
  }
  return [...out.values()];
}
