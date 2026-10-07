import { describeFrame, parseFigmaDesign } from "../../design/figma.ts";
import { type McpProfile, type ProfileCapability, params } from "../types.ts";

/**
 * Figma profile (ADR-0017 §4): a design frame by the link the task or a requirements page carries
 * (`figma.com/design/<fileKey>/…?node-id=…`), as structured text — layers, texts, sizes, colours,
 * spacing — which a text model reads better than a picture. Built for the community server
 * `figma-developer-mcp` (`get_figma_data`); its token is the person's (a personal access token).
 * Pilot: the requirements page embedded the frames; the agents had the links and nothing to open them.
 */
export function figmaRef(link: string): { fileKey: string; nodeId?: string } | undefined {
  let url: URL;
  try {
    // a link pasted into zsh comes with `\?`, `\=`, `\&` (url-quote-magic); inside quotes they stay
    url = new URL(link.trim().replace(/\\(?=[?=&#])/g, ""));
  } catch {
    return undefined;
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return undefined;
  const m = /^\/(?:design|file|proto|board)\/([a-zA-Z0-9]+)/.exec(url.pathname);
  if (!m) return undefined;
  const nodeId = url.searchParams.get("node-id") ?? undefined;
  return { fileKey: m[1] as string, ...(nodeId ? { nodeId } : {}) };
}

const figmaGet: ProfileCapability = {
  tools: ["get_figma_data"],
  description:
    "Read a Figma design frame by its link (figma.com/design/<key>/…?node-id=…): its texts in order with their styles, the layout tree with gaps and paddings, the design-system components with their properties, the spacing and colours used. Pass the link as it is. A whole screen or page may take long or time out: then read it again with depth 3–4, or read its smaller frames. raw: true — the server's JSON as it is.",
  access: "read",
  effect: false,
  parameters: params(
    {
      url: "the frame's figma.com link, with node-id",
      depth: "levels of children to include (optional)",
      raw: "true — the server's JSON instead of the description",
      fresh: "true — read it again even if Jarvis read it within a day",
    },
    ["url"],
  ),
  args: (a) => {
    const ref = typeof a.url === "string" ? figmaRef(a.url) : undefined;
    const fileKey = ref?.fileKey ?? a.fileKey;
    const nodeId = ref?.nodeId ?? a.nodeId;
    // a whole design file is more than the API gives at once ("Request too large"), and more than a
    // step needs: a frame, by its node-id (pilot: a link lost its node-id in the shell)
    if (!fileKey || !nodeId)
      throw new Error(
        `figma.get needs a frame link with node-id (figma.com/design/<key>/…?node-id=…); got ${typeof a.url === "string" ? a.url : "no url"}`,
      );
    return { fileKey, nodeId, depth: a.depth };
  },
  // a frame changes rarely and a seat may have 20 reads a month: one read a day is enough
  cacheMs: 24 * 3_600_000,
  // "Figma API rate limit hit (429). Retry after 396759 seconds" — not asked again until then
  retryAfterSeconds: (r) => {
    const m = /rate limit[^\n]*?retry after (\d+) ?s/i.exec(r.text);
    return m ? Number(m[1]) : undefined;
  },
  // the JSON (OUTPUT_FORMAT=json) described by code; the tree or YAML formats pass as they are
  enrich: async (result, args) => {
    if (!result.ok || args.raw === true || args.raw === "true") return result;
    const design = parseFigmaDesign(result.text);
    if (!design) return result;
    const link = typeof args.url === "string" ? args.url.replace(/\\(?=[?=&#])/g, "") : undefined;
    return { ...result, text: describeFrame(design, link ? { link } : {}).text };
  },
};

export const figmaProfile: McpProfile = {
  name: "figma",
  version: 1,
  network: "internet",
  map: { "figma.get": figmaGet },
};
