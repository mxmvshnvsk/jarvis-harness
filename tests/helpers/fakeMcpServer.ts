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

server.registerTool(
  "whoami",
  { description: "returns the token the server was started with", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: `token=${process.env.JIRA_TOKEN ?? "none"}` }] }),
);

server.registerTool("echo", { description: "echo", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text }],
}));

await server.connect(new StdioServerTransport());
