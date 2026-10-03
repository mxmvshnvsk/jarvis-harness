import { type McpProfile, type ProfileCapability, params } from "../types.ts";

/** Bitbucket profile (ADR-0017 §4): pull requests. Candidates cover the common community servers. */
const prGet: ProfileCapability = {
  tools: ["get_pull_request", "bitbucket_get_pull_request", "getPullRequest"],
  description: "Read a pull request: title, description, state, reviewers, comments.",
  access: "read",
  effect: false,
  parameters: params({ workspace: "workspace slug", repo: "repository slug", id: "pull request id" }, [
    "workspace",
    "repo",
    "id",
  ]),
  args: (a) => ({
    workspace: a.workspace,
    repo_slug: a.repo,
    repository: a.repo,
    pull_request_id: a.id,
    prId: a.id,
    id: a.id,
  }),
};

const prList: ProfileCapability = {
  tools: ["list_pull_requests", "bitbucket_list_pull_requests", "listPullRequests"],
  description: "List pull requests of a repository, optionally by state.",
  access: "read",
  effect: false,
  parameters: params(
    { workspace: "workspace slug", repo: "repository slug", state: "OPEN | MERGED | DECLINED" },
    ["workspace", "repo"],
  ),
  args: (a) => ({ workspace: a.workspace, repo_slug: a.repo, repository: a.repo, state: a.state ?? "OPEN" }),
};

const prDiff: ProfileCapability = {
  tools: ["get_pull_request_diff", "bitbucket_get_pull_request_diff", "getPullRequestDiff"],
  description: "Read the diff of a pull request.",
  access: "read",
  effect: false,
  parameters: params({ workspace: "workspace slug", repo: "repository slug", id: "pull request id" }, [
    "workspace",
    "repo",
    "id",
  ]),
  args: (a) => ({
    workspace: a.workspace,
    repo_slug: a.repo,
    repository: a.repo,
    pull_request_id: a.id,
    prId: a.id,
    id: a.id,
  }),
};

const prCreate: ProfileCapability = {
  tools: ["create_pull_request", "bitbucket_create_pull_request", "createPullRequest"],
  description: "Open a pull request. An effect: verified by the marker in the description.",
  access: "write",
  effect: true,
  parameters: params(
    {
      workspace: "workspace slug",
      repo: "repository slug",
      title: "title",
      description: "description (markdown)",
      source: "source branch",
      target: "destination branch",
    },
    ["workspace", "repo", "title", "source", "target"],
  ),
  markerArg: "description",
  args: (a) => ({
    workspace: a.workspace,
    repo_slug: a.repo,
    repository: a.repo,
    title: a.title,
    description: a.description,
    source_branch: a.source,
    sourceBranch: a.source,
    destination_branch: a.target,
    destinationBranch: a.target,
  }),
  verify: async (connection, resolveTool, args, marker) => {
    const tool = resolveTool(prList.tools);
    if (!tool) return undefined;
    const result = await connection.callTool(tool, prList.args?.({ ...args, state: "OPEN" }) ?? args);
    if (!result.ok) return undefined;
    return result.text.includes(marker) ? result : "not-found";
  },
};

const prComment: ProfileCapability = {
  tools: ["add_pull_request_comment", "bitbucket_add_pr_comment", "add_comment", "addPullRequestComment"],
  description: "Comment on a pull request. An effect: verified by the marker in the comments.",
  access: "write",
  effect: true,
  parameters: params(
    { workspace: "workspace slug", repo: "repository slug", id: "pull request id", content: "comment text" },
    ["workspace", "repo", "id", "content"],
  ),
  markerArg: "content",
  args: (a) => ({
    workspace: a.workspace,
    repo_slug: a.repo,
    repository: a.repo,
    pull_request_id: a.id,
    prId: a.id,
    id: a.id,
    content: a.content ?? a.body,
    text: a.content ?? a.body,
  }),
  verify: async (connection, resolveTool, args, marker) => {
    const tool = resolveTool(prGet.tools);
    if (!tool) return undefined;
    const result = await connection.callTool(tool, prGet.args?.(args) ?? args);
    if (!result.ok) return undefined;
    return result.text.includes(marker) ? result : "not-found";
  },
};

export const bitbucketProfile: McpProfile = {
  name: "bitbucket",
  version: 1,
  network: "intranet",
  map: {
    "bitbucket.pr.get": prGet,
    "bitbucket.pr.list": prList,
    "bitbucket.pr.diff": prDiff,
    "bitbucket.pr.create": prCreate,
    "bitbucket.pr.comment": prComment,
  },
};
