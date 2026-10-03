import { type McpProfile, type ProfileCapability, params } from "../types.ts";

/**
 * Atlassian profile (ADR-0017 §4): Jira and Confluence. Tool candidates cover the official Atlassian
 * Remote MCP server (camelCase) and the common community server (`jira_*` / `confluence_*`).
 */
const jiraGet: ProfileCapability = {
  tools: ["getJiraIssue", "jira_get_issue", "get_issue"],
  description: "Read one Jira issue by key: summary, description, status, links, comments.",
  access: "read",
  effect: false,
  parameters: params({ key: "issue key, e.g. ABC-42" }, ["key"]),
  args: (a) => ({ issueKey: a.key ?? a.issueKey, issue_key: a.key ?? a.issueKey }),
};

const jiraSearch: ProfileCapability = {
  tools: ["searchJiraIssuesUsingJql", "jira_search", "search_issues"],
  description: "Search Jira issues with JQL.",
  access: "read",
  effect: false,
  parameters: params({ jql: "JQL query", limit: "max results (default 20)" }, ["jql"]),
  args: (a) => ({ jql: a.jql, maxResults: a.limit ?? 20, limit: a.limit ?? 20 }),
};

const jiraComment: ProfileCapability = {
  tools: ["addCommentToJiraIssue", "jira_add_comment", "add_comment"],
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
  tools: ["transitionJiraIssue", "jira_transition_issue", "transition_issue"],
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
  tools: ["getConfluencePage", "confluence_get_page", "get_page"],
  description: "Read a Confluence page by id.",
  access: "read",
  effect: false,
  parameters: params({ id: "page id" }, ["id"]),
  args: (a) => ({ pageId: a.id ?? a.pageId, page_id: a.id ?? a.pageId }),
};

const confluenceSearch: ProfileCapability = {
  tools: ["searchConfluenceUsingCql", "confluence_search", "search"],
  description: "Search Confluence with CQL or free text.",
  access: "read",
  effect: false,
  parameters: params({ query: "free text", cql: "CQL query (alternative to query)", limit: "max results" }),
  args: (a) => ({ cql: a.cql ?? a.query, query: a.query ?? a.cql, limit: a.limit ?? 10 }),
};

const confluenceCreate: ProfileCapability = {
  tools: ["createConfluencePage", "confluence_create_page", "create_page"],
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
