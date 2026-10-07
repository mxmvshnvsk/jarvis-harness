import { type McpProfile, type ProfileCapability, params } from "../types.ts";

/**
 * Atlassian profile (ADR-0017 §4): Jira and Confluence. Tool candidates cover the official Atlassian
 * Remote MCP server (camelCase), the common community server (`jira_*` / `confluence_*`) and the Data
 * Center servers `@atlassian-dc-mcp/jira` and `@atlassian-dc-mcp/confluence` (`jira_getIssue`,
 * `confluence_getContent`, … — one server each, so one profile serves both). Arguments carry every
 * known spelling; the call keeps only those the tool's schema declares.
 */
const jiraGet: ProfileCapability = {
  tools: ["getJiraIssue", "jira_get_issue", "jira_getIssue", "get_issue"],
  description: "Read one Jira issue by key: summary, description, status, links, comments.",
  access: "read",
  effect: false,
  parameters: params({ key: "issue key, e.g. ABC-42" }, ["key"]),
  args: (a) => ({ issueKey: a.key ?? a.issueKey, issue_key: a.key ?? a.issueKey }),
};

const jiraSearch: ProfileCapability = {
  tools: ["searchJiraIssuesUsingJql", "jira_search", "jira_searchIssues", "search_issues"],
  description: "Search Jira issues with JQL.",
  access: "read",
  effect: false,
  parameters: params({ jql: "JQL query", limit: "max results (default 20)" }, ["jql"]),
  args: (a) => ({ jql: a.jql, maxResults: a.limit ?? 20, limit: a.limit ?? 20 }),
};

const jiraComment: ProfileCapability = {
  tools: ["addCommentToJiraIssue", "jira_add_comment", "jira_postIssueComment", "add_comment"],
  description: "Add a comment to a Jira issue. An effect: journaled and verified by marker.",
  access: "write",
  effect: true,
  parameters: params({ key: "issue key", body: "comment text (markdown)" }, ["key", "body"]),
  markerArg: "body",
  args: (a) => ({
    issueKey: a.key ?? a.issueKey,
    issue_key: a.key ?? a.issueKey,
    commentBody: a.body,
    comment: a.body,
    body: a.body,
  }),
  verify: async (connection, resolveTool, args, marker) => {
    const tool = resolveTool(jiraGet.tools);
    if (!tool) return undefined;
    const result = await connection.callTool(tool, jiraGet.args?.(args) ?? args);
    if (!result.ok) return undefined;
    return result.text.includes(marker) ? result : "not-found";
  },
};

const jiraTransition: ProfileCapability = {
  tools: ["transitionJiraIssue", "jira_transition_issue", "jira_transitionIssue", "transition_issue"],
  description: "Move a Jira issue to another status. An effect: verified by reading the status back.",
  access: "write",
  effect: true,
  parameters: params({ key: "issue key", transition: "target status or transition id" }, [
    "key",
    "transition",
  ]),
  args: (a) => ({
    issueKey: a.key ?? a.issueKey,
    issue_key: a.key ?? a.issueKey,
    transition: a.transition,
    transition_id: a.transition,
    transitionId: a.transition,
  }),
  verify: async (connection, resolveTool, args, _marker) => {
    const tool = resolveTool(jiraGet.tools);
    if (!tool) return undefined;
    const result = await connection.callTool(tool, jiraGet.args?.(args) ?? args);
    if (!result.ok) return undefined;
    const wanted = String(args.transition ?? "");
    return wanted.length > 0 && result.text.toLowerCase().includes(wanted.toLowerCase())
      ? result
      : "not-found";
  },
};

const confluenceGet: ProfileCapability = {
  tools: ["getConfluencePage", "confluence_get_page", "confluence_getContent", "get_page"],
  description:
    "Read a Confluence page by id. raw: true — the page's storage HTML with its macros (embedded designs, diagrams, includes), much longer than the text.",
  access: "read",
  effect: false,
  parameters: params({ id: "page id", raw: "true — storage HTML with macros instead of text" }, ["id"]),
  args: (a) => {
    // what an embedded frame (Widget Connector, a design macro) points to lives in a macro attribute,
    // which the text conversion drops (pilot: a design link on the requirements page never reached the agent)
    const raw = a.raw === true || a.raw === "true";
    return {
      pageId: a.id ?? a.pageId,
      page_id: a.id ?? a.pageId,
      contentId: a.id ?? a.pageId,
      // Data Center: the body as text, not storage-format XML the agent would have to read through
      bodyMode: raw ? "storage" : "text",
      convert_to_markdown: !raw,
    };
  },
  // the text, then what it lost: the addresses of embedded frames, from the storage HTML
  enrich: async (result, args, again) => {
    if (!result.ok || args.raw === true || args.raw === "true") return result;
    const raw = await again({ ...args, raw: true });
    if (!raw.ok) return result;
    const links = embeddedLinks(raw.text).filter((u) => !result.text.includes(u));
    if (links.length === 0) return result;
    return {
      ...result,
      text: `${result.text}\n\nEmbedded on the page (frames and macros the text above leaves out):\n${links.map((u) => `- ${u}`).join("\n")}`,
    };
  },
};

/**
 * Addresses a page embeds through macros — a design frame (Widget Connector, a design app's macro),
 * an iframe — from its storage HTML: the text conversion keeps a plain link but drops a macro's
 * attributes. Pilot: the requirements page embedded the design frame; the agent never saw it.
 */
export function embeddedLinks(storage: string): string[] {
  const text = storage
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&");
  const found = [
    ...text.matchAll(/<ri:url\s+ri:value="(https?:\/\/[^"]+)"/g),
    ...text.matchAll(/<ac:parameter\s+ac:name="(?:url|link|src|href)"\s*>\s*(https?:\/\/[^<\s]+)\s*</g),
    ...text.matchAll(/<iframe[^>]*\ssrc="(https?:\/\/[^"]+)"/g),
  ].map((m) => m[1] as string);
  return [...new Set(found)].slice(0, 20);
}

const confluenceSearch: ProfileCapability = {
  tools: ["searchConfluenceUsingCql", "confluence_search", "confluence_searchContent", "search"],
  description: "Search Confluence with CQL or free text.",
  access: "read",
  effect: false,
  parameters: params({ query: "free text", cql: "CQL query (alternative to query)", limit: "max results" }),
  // a server that takes only CQL gets free text as `text ~ "…"` (Data Center: CQL is required)
  args: (a) => ({
    cql: a.cql ?? (typeof a.query === "string" ? `text ~ "${a.query.replace(/["\\]/g, " ")}"` : undefined),
    query: a.query ?? a.cql,
    limit: a.limit ?? 10,
    excerpt: "highlight",
  }),
};

const confluenceCreate: ProfileCapability = {
  tools: ["createConfluencePage", "confluence_create_page", "confluence_createContent", "create_page"],
  description: "Create a Confluence page. An effect: verified by searching for the marker.",
  access: "write",
  effect: true,
  parameters: params(
    { space: "space key or id", title: "page title", body: "page body", parent: "parent page id" },
    ["space", "title", "body"],
  ),
  markerArg: "body",
  args: (a) => ({
    spaceId: a.space,
    space_key: a.space,
    spaceKey: a.space,
    title: a.title,
    body: a.body,
    content: a.body,
    parentId: a.parent,
    parent_id: a.parent,
  }),
  verify: async (connection, resolveTool, _args, marker) => {
    const tool = resolveTool(confluenceSearch.tools);
    if (!tool) return undefined;
    const result = await connection.callTool(tool, { cql: `text ~ "${marker}"`, query: marker, limit: 5 });
    if (!result.ok) return undefined;
    return result.text.includes(marker) ? result : "not-found";
  },
};

export const atlassianProfile: McpProfile = {
  name: "atlassian",
  version: 1,
  network: "intranet",
  map: {
    "jira.get": jiraGet,
    "jira.search": jiraSearch,
    "jira.comment": jiraComment,
    "jira.transition": jiraTransition,
    "confluence.get": confluenceGet,
    "confluence.search": confluenceSearch,
    "confluence.create": confluenceCreate,
  },
};
