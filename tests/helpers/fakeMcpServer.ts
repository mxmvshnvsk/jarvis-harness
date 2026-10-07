import { appendFileSync, readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * A stdio MCP server that plays a tiny Jira. Spawned by tests as a stdio server.
 *   FAKE_MCP_STATE   — file the comments are appended to (so a second process sees them)
 *   FAKE_MCP_CRASH   — "comment": exit right after writing the comment, before replying
 *   JIRA_TOKEN       — echoed by `whoami` (to prove env injection and redaction)
 */
const stateFile = process.env.FAKE_MCP_STATE;
const comments: string[] = [];
function allComments(): string[] {
  if (!stateFile) return comments;
  try {
    return readFileSync(stateFile, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const server = new McpServer({ name: "fake-jira", version: "1.0.0" });

server.registerTool(
  "getJiraIssue",
  { description: "issue by key", inputSchema: { issueKey: z.string() } },
  async ({ issueKey }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          key: issueKey,
          summary: "Allow onboarding restart",
          description: "Requirements: https://confluence.example.corp/spaces/WEB/pages/77770077/Order-form",
          status: "To Do",
          comments: allComments(),
        }),
      },
    ],
  }),
);

server.registerTool(
  "searchJiraIssuesUsingJql",
  { description: "jql search", inputSchema: { jql: z.string(), maxResults: z.number().optional() } },
  async ({ jql }) => ({ content: [{ type: "text", text: `results for ${jql}: ABC-42` }] }),
);

server.registerTool(
  "addCommentToJiraIssue",
  { description: "add comment", inputSchema: { issueKey: z.string(), commentBody: z.string() } },
  async ({ issueKey, commentBody }) => {
    const line = `${issueKey}: ${commentBody.replace(/\n/g, " ")}`;
    if (stateFile) appendFileSync(stateFile, `${line}\n`);
    else comments.push(line);
    if (process.env.FAKE_MCP_CRASH === "comment") process.exit(3);
    return { content: [{ type: "text", text: `comment added to ${issueKey}` }] };
  },
);

// a Confluence page whose design is an embedded frame: the URL lives in a macro attribute, which the
// markdown conversion of the community server drops (pilot)
const PAGE_STORAGE =
  '<h1>Order form</h1><p>The phone field gets a mask.</p><ac:structured-macro ac:name="widget"><ac:parameter ac:name="url"><ri:url ri:value="https://www.figma.com/design/AbC123xyz/Order-form?node-id=12-345&amp;t=x" /></ac:parameter></ac:structured-macro><ac:structured-macro ac:name="widget"><ac:parameter ac:name="url"><ri:url ri:value="https://www.figma.com/design/AbC123xyz/Order-form?node-id=66-77" /></ac:parameter></ac:structured-macro>';

// a frame as figma-developer-mcp answers it with OUTPUT_FORMAT=json (a SimplifiedDesign), trimmed
const FRAME = {
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
          layout: "layout_CCC333",
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
  components: { "1:10": { id: "1:10", key: "k", name: "Content=True", componentSetId: "1:9" } },
  componentSets: { "1:9": { id: "1:9", key: "k", name: "[D] UniversalModalHeader" } },
  globalVars: {
    styles: {
      layout_AAA111: {
        mode: "column",
        padding: "20px 20px 0px",
        gap: "12px",
        sizing: { horizontal: "fill", vertical: "hug" },
      },
      layout_CCC333: { mode: "none", sizing: { horizontal: "fill", vertical: "hug" } },
      fill_BBB222: ["rgba(3, 3, 6, 0.88)"],
      "Headline–System/22–26 Small": {
        fontFamily: "Sans",
        fontWeight: 700,
        fontSize: 22,
        lineHeight: "26px",
      },
      "Text/16–24": { fontSize: 16, lineHeight: "24px", fontWeight: 400 },
    },
  },
  elements: { tpl_hint: { type: "TEXT", textStyle: "Text/16–24", fills: ["#7A7A7F"] } },
};
server.registerTool(
  "get_figma_data",
  {
    description: "a frame",
    inputSchema: { fileKey: z.string(), nodeId: z.string().optional(), depth: z.number().optional() },
  },
  async ({ nodeId }) =>
    nodeId === "66-77"
      ? { isError: true, content: [{ type: "text", text: "Request too large" }] }
      : { content: [{ type: "text", text: JSON.stringify(FRAME) }] },
);
server.registerTool(
  "confluence_get_page",
  {
    description: "page by id",
    inputSchema: { page_id: z.string(), convert_to_markdown: z.boolean().optional() },
  },
  async ({ page_id, convert_to_markdown }) => ({
    content: [
      {
        type: "text",
        text:
          convert_to_markdown === false
            ? JSON.stringify({ metadata: { id: page_id }, content: { value: PAGE_STORAGE } })
            : JSON.stringify({
                metadata: { id: page_id },
                content: { value: "Order form\n==========\n\nThe phone field gets a mask.\n" },
              }),
      },
    ],
  }),
);

server.registerTool(
  "whoami",
  { description: "returns the token the server was started with", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: `token=${process.env.JIRA_TOKEN ?? "none"}` }] }),
);

server.registerTool(
  "echo",
  { description: "echo", inputSchema: { text: z.string(), delayMs: z.number().optional() } },
  async ({ text, delayMs }) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { content: [{ type: "text", text }] };
  },
);

await server.connect(new StdioServerTransport());
