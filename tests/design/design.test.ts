import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { describeFrame, type FigmaDesign, figmaLinksIn, parseFigmaDesign } from "../../src/design/figma.ts";
import { McpResultStore } from "../../src/mcp/client/results.ts";
import { createRun, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** A design frame read by code, and the `design` step that reads the task's frames before any agent. */
const FRAME: FigmaDesign = {
  name: "Order form '26",
  nodes: [
    {
      id: "12:345",
      name: "[D] UniversalModalHeader",
      type: "INSTANCE",
      layout: "layout_AAA111",
      fills: ["#FFFFFF"],
      componentId: "1:10",
      componentProperties: { "✎ Title": "Phone number", BackWord: true },
      children: [
        {
          id: "12:346",
          type: "TEXT",
          text: "Phone number",
          textStyle: "Headline–System/22–26 Small",
          fills: "fill_BBB222",
        },
        { id: "12:347", template: "tpl_hint", text: "We send a code to it" },
        {
          id: "12:348",
          name: "Cross",
          type: "IMAGE-SVG",
          layout: { mode: "none", dimensions: { width: 48, height: 48 } },
        },
      ],
    },
  ],
  components: { "1:10": { name: "Content=True", componentSetId: "1:9" } },
  componentSets: { "1:9": { name: "[D] UniversalModalHeader" } },
  globalVars: {
    styles: {
      layout_AAA111: {
        mode: "column",
        padding: "20px 20px 0px",
        gap: "12px",
        sizing: { horizontal: "fill", vertical: "hug" },
      },
      fill_BBB222: ["rgba(3, 3, 6, 0.88)"],
      "Headline–System/22–26 Small": { fontWeight: 700, fontSize: 22, lineHeight: "26px" },
      style_ZZZ999: { fontSize: 16, lineHeight: "24px", fontWeight: 400 },
    },
  },
  elements: { tpl_hint: { type: "TEXT", textStyle: "style_ZZZ999", fills: ["#7A7A7F"] } },
};

describe("a Figma frame described by code", () => {
  it("texts in order with style and colour, the layout tree, components with properties, spacing", () => {
    const d = describeFrame(FRAME, { link: "https://www.figma.com/design/K/x?node-id=12-345" });
    expect(d.texts).toBe(2);
    expect(d.components).toEqual(["[D] UniversalModalHeader"]);
    const t = d.text;
    expect(t).toContain("### [D] UniversalModalHeader (Content=True)");
    expect(t).toContain(
      "Figma: Order form '26 · node 12:345 · https://www.figma.com/design/K/x?node-id=12-345",
    );
    expect(t).toContain("- «Phone number» — Headline–System/22–26 Small (22/26 700), rgba(3, 3, 6, 0.88)");
    // a template element supplies the type and the style; a generated style key shows its numbers
    expect(t).toContain("- «We send a code to it» — 16/24 400, #7A7A7F");
    expect(t).toContain(
      '- [D] UniversalModalHeader (Content=True) · Title="Phone number", BackWord=true — column, gap 12px, padding 20px 20px 0px, fill/hug, bg #FFFFFF',
    );
    expect(t).toContain('  - image-svg "Cross" — 48×48');
    expect(t).toContain("Gaps: 12px · paddings: 20px 20px 0px");
    expect(t).toContain("Colours (for meaning, not to copy): #7A7A7F, rgba(3, 3, 6, 0.88)");
  });

  it("reads the server's actual shape: the name and the dictionaries under metadata", () => {
    const { name: _n, components, componentSets, ...rest } = FRAME;
    const actual = { ...rest, metadata: { name: "Order form '26", components, componentSets } };
    const t = describeFrame(parseFigmaDesign(JSON.stringify(actual)) as FigmaDesign).text;
    expect(t).toContain("### [D] UniversalModalHeader (Content=True)");
    expect(t).toContain("Figma: Order form '26 · node 12:345");
    expect(t).toContain("Design-system components: [D] UniversalModalHeader");
  });

  it("knows the JSON answer from the tree or YAML formats", () => {
    expect(parseFigmaDesign(JSON.stringify(FRAME))?.name).toBe("Order form '26");
    expect(parseFigmaDesign("NAME: x\nNODES:\n")).toBeUndefined();
    expect(parseFigmaDesign("{ not json")).toBeUndefined();
  });

  it("finds frame links, once per file and node, never a whole file", () => {
    const text = [
      "see https://www.figma.com/design/K1/Form?node-id=1-2&t=a.",
      "- https://www.figma.com/design/K1/Form?node-id=1-2&t=b",
      "| https://figma.com/file/K2/Old?node-id=3%3A4 |",
      "https://www.figma.com/design/K3/Whole-file",
      "https://www.figma.com/design/K1/Form?node-id=5-6",
    ].join("\n");
    expect(figmaLinksIn(text)).toEqual([
      "https://www.figma.com/design/K1/Form?node-id=1-2&t=a",
      "https://www.figma.com/design/K1/Form?node-id=5-6",
    ]);
  });
});

describe("the design step", () => {
  const FIXTURE = join(import.meta.dirname, "..", "helpers", "fakeMcpServer.ts");
  let sb: Sandbox;
  let rt: Runtime | undefined;
  beforeEach(() => {
    sb = sandbox();
  });
  afterEach(async () => {
    await rt?.close();
    rt = undefined;
    sb.cleanup();
  });
  const server = (id: string, extra: string) => `    ${id}:
      transport: stdio
      command: node
      args: ["${FIXTURE}"]
${extra}`;
  const reads = () =>
    existsSync(join(sb.root, "figma.log"))
      ? readFileSync(join(sb.root, "figma.log"), "utf8").split("\n").filter(Boolean)
      : [];
  async function setup(withFigma: boolean, before?: () => void) {
    sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
    sb.write(
      "project/.jarvis/project.yaml",
      `version: 1
dataClass: confidential
workspace: { mode: cwd }
mcp:
  servers:
${server("atl", "      profile: atlassian")}
${withFigma ? server("design", `      profile: figma\n      network: internet\n      env: { FAKE_MCP_FIGMA_LOG: "${join(sb.root, "figma.log")}" }`) : ""}
${withFigma ? 'egressExceptions:\n  - server: design\n    reason: "frames of the team\'s designs"' : ""}
`,
    );
    rt = await testRuntime(sb, {
      PATH: process.env.PATH ?? "",
      FAKE_MCP_FIGMA_LOG: join(sb.root, "figma.log"),
    });
    before?.();
    const wf = workflowOf({
      name: "d",
      entry: "design",
      steps: [
        {
          id: "design",
          kind: "deterministic",
          tool: "design.collect",
          outputs: ["design"],
          transitions: { onSuccess: "DONE" },
        },
      ],
    });
    const run = createRun(rt, "d", "ABC-42: order form phone mask");
    return { run: await engineFor(rt, [wf]).execute(run.id, { owner: "cli:t" }) };
  }

  it("issue → its page → every frame there, described; what failed is listed; all through the router", async () => {
    const { run } = await setup(true);
    expect(run.run.state).toBe("COMPLETED");
    const runtime = rt as Runtime;
    const design = runtime.artifacts.listLatest(run.run.id, "design")[0];
    expect(design?.provenance).toMatchObject({ kind: "tool", capability: "design.collect" });
    const text = runtime.artifacts.text(design as never);
    expect(text).toContain("1 frame read, 1 not");
    expect(text).toContain("## 1. [D] UniversalModalHeader (Content=True)");
    expect(text).toContain(
      "From Confluence (77770077) · https://www.figma.com/design/AbC123xyz/Order-form?node-id=12-345&t=x",
    );
    expect(text).toContain("- «Phone number» — Headline–System/22–26 Small (22/26 700)");
    expect(text).toContain(
      "## Not read\n- https://www.figma.com/design/AbC123xyz/Order-form?node-id=66-77 (from Confluence (77770077)) — Request too large",
    );
    const calls = runtime.events
      .list({ runId: run.run.id, kind: "tool.call" })
      .map((e) => e.payload?.capability);
    expect(calls).toEqual(["jira.get", "confluence.get", "figma.get", "figma.get"]);
    // the egress exception is on the record of the frame calls
    expect(runtime.events.list({ runId: run.run.id, kind: "tool.call" })[2]?.payload).toMatchObject({
      egressException: "frames of the team's designs",
    });
  });

  it("a frame read today is not read again; fresh reads it; a 429 stops calls to the server until its Retry-After", async () => {
    await setup(true);
    const runtime = rt as Runtime;
    expect(reads()).toEqual(["12-345", "66-77"]); // the step read the page's two frames
    const link = "https://www.figma.com/design/AbC123xyz/Order-form?node-id=12-345";
    // the same frame again: from the cache, the server not asked
    const again = await runtime.mcp.provider.invoke("figma.get", { url: link });
    expect(again.result.ok).toBe(true);
    expect(again.result.text).toContain("### [D] UniversalModalHeader (Content=True)");
    expect(reads()).toEqual(["12-345", "66-77"]);
    await runtime.mcp.provider.invoke("figma.get", { url: link, fresh: true });
    expect(reads()).toEqual(["12-345", "66-77", "12-345"]);
    // the API says "not before": the next frames are not asked for until then
    const limited = await runtime.mcp.provider.invoke("figma.get", { url: link.replace("12-345", "88-99") });
    expect(limited.result.ok).toBe(false);
    expect(limited.result.text).toMatch(/\[jarvis: no calls to "design" before \d{4}-\d\d-\d\dT/);
    const blocked = await runtime.mcp.provider.invoke("figma.get", { url: link, fresh: true });
    expect(blocked.result.text).toMatch(/^rate limit of MCP server "design": not called before /);
    expect(reads()).toEqual(["12-345", "66-77", "12-345", "88-99"]);
  });

  it("the step under a rate limit: nothing asked, every frame listed with until when", async () => {
    const { run } = await setup(true, () =>
      new McpResultStore(join(sb.home, ".jarvis", "cache", "mcp-results")).block("design", 3600, "429"),
    );
    const runtime = rt as Runtime;
    expect(reads()).toEqual([]);
    const text = runtime.artifacts.text(runtime.artifacts.listLatest(run.run.id, "design")[0] as never);
    expect(text).toContain("0 frames read, 2 not");
    expect(text.match(/— the Figma API's rate limit until \d{4}-/g)).toHaveLength(2);
  });

  it("without figma.get the step reads nothing and leaves no artifact", async () => {
    const { run } = await setup(false);
    expect(run.run.state).toBe("COMPLETED");
    expect((rt as Runtime).artifacts.listLatest(run.run.id, "design")).toEqual([]);
    expect((rt as Runtime).events.list({ runId: run.run.id, kind: "tool.call" })).toEqual([]);
  });
});
