import { type McpProfile, type ProfileCapability, params } from "../types.ts";

/**
 * Bitbucket profile (ADR-0017 §4): pull requests. Candidates cover the common community servers; on
 * Bitbucket Server/Data Center `workspace` is the project key.
 */
/** A PR's number as the server wants it: a number (`--arg id=312` may come as text). */
function prNumber(v: unknown): unknown {
  return typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
}

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
    pull_request_id: prNumber(a.id),
    prId: a.id,
    id: a.id,
    // the PR flow reads every open thread and the tasks (Bitbucket Server), not the first 20
    include_tasks: true,
    comment_limit: 100,
  }),
};

const prCommits: ProfileCapability = {
  tools: ["list_pr_commits", "bitbucket_list_pr_commits", "listPullRequestCommits"],
  description: "List the commits of a pull request, the latest first, with their build status.",
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
    pull_request_id: prNumber(a.id),
    include_build_status: true,
    limit: 5,
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
    pull_request_id: prNumber(a.id),
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
    pull_request_id: prNumber(a.id),
    prId: a.id,
    id: a.id,
    content: a.content ?? a.body,
    text: a.content ?? a.body,
    comment_text: a.content ?? a.body,
  }),
  verify: async (connection, resolveTool, args, marker) => {
    const tool = resolveTool(prGet.tools);
    if (!tool) return undefined;
    const result = await connection.callTool(tool, prGet.args?.(args) ?? args);
    if (!result.ok) return undefined;
    return result.text.includes(marker) ? result : "not-found";
  },
};

/* ---- reading a branch (ADR-0026: the work of a related task, before its PR is merged) ---- */

const where = (a: Record<string, unknown>) => ({
  workspace: a.workspace,
  project: a.workspace,
  projectKey: a.workspace,
  repository: a.repo,
  repo_slug: a.repo,
  repositorySlug: a.repo,
});

const branchList: ProfileCapability = {
  tools: ["list_branches", "bitbucket_list_branches", "listBranches"],
  description: "List the branches of a repository, optionally those whose name contains a text.",
  access: "read",
  effect: false,
  parameters: params(
    { workspace: "workspace or project key", repo: "repository slug", filter: "text in the name" },
    ["workspace", "repo"],
  ),
  args: (a) => ({ ...where(a), filter: a.filter, filterText: a.filter, query: a.filter, limit: 50 }),
};

const branchCommits: ProfileCapability = {
  tools: ["list_branch_commits", "bitbucket_list_branch_commits", "listBranchCommits"],
  description: "List the latest commits of a branch.",
  access: "read",
  effect: false,
  parameters: params(
    { workspace: "workspace or project key", repo: "repository slug", branch: "branch name" },
    ["workspace", "repo", "branch"],
  ),
  args: (a) => ({ ...where(a), branch: a.branch, branch_name: a.branch, branchName: a.branch, limit: 30 }),
};

const commitGet: ProfileCapability = {
  tools: ["get_commit_detail", "bitbucket_get_commit", "getCommit"],
  description: "Read one commit: message, author and the files it changed.",
  access: "read",
  effect: false,
  parameters: params(
    { workspace: "workspace or project key", repo: "repository slug", commit: "commit id" },
    ["workspace", "repo", "commit"],
  ),
  args: (a) => ({
    ...where(a),
    commit: a.commit,
    commit_id: a.commit,
    commitId: a.commit,
    commit_hash: a.commit,
  }),
};

const fileGet: ProfileCapability = {
  tools: ["get_file_content", "bitbucket_get_file_content", "getFileContent"],
  description: "Read a file of a repository at a branch or commit.",
  access: "read",
  effect: false,
  parameters: params(
    {
      workspace: "workspace or project key",
      repo: "repository slug",
      path: "file path",
      ref: "branch or commit",
    },
    ["workspace", "repo", "path"],
  ),
  args: (a) => ({
    ...where(a),
    path: a.path,
    file_path: a.path,
    filePath: a.path,
    ref: a.ref,
    branch: a.ref,
    at: a.ref,
  }),
};

export const bitbucketProfile: McpProfile = {
  name: "bitbucket",
  version: 1,
  network: "intranet",
  map: {
    "bitbucket.pr.get": prGet,
    "bitbucket.pr.list": prList,
    "bitbucket.pr.diff": prDiff,
    "bitbucket.pr.commits": prCommits,
    "bitbucket.pr.create": prCreate,
    "bitbucket.pr.comment": prComment,
    "bitbucket.branch.list": branchList,
    "bitbucket.branch.commits": branchCommits,
    "bitbucket.commit.get": commitGet,
    "bitbucket.file.get": fileGet,
  },
};
