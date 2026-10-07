import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODULE_MARKER } from "../../src/onboarding/render.ts";
import { findNode, moduleTree, TOO_BIG } from "../../src/onboarding/tree.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** What the Modules page offers to research: modules, folders inside them, size, knowledge. */
let sb: Sandbox;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: sb.project, encoding: "utf8", env: { ...process.env, ...gitEnv } });
const put = (rel: string, text: string) => sb.write(`project/${rel}`, text);
const roots = () => ({
  projectRoot: sb.project,
  userRoot: sb.home,
  sources: [
    {
      path: "documentation",
      include: ["**/*.md"],
      skills: [],
      scopes: { "upload/**": ["src/shared/upload/**"] },
      agents: [],
      exclude: [],
    },
  ],
  isDenied: (rel: string) => rel.startsWith("secrets/"),
});

beforeEach(() => {
  sb = sandbox();
  put("src/orders/order.ts", "export class Order {}\n");
  put("src/index.ts", "export {};\n");
  put("src/orders/form/step.ts", "export const step = 1;\n");
  put("src/shared/api/client.ts", "export const api = {};\n");
  put("src/shared/upload/toggle.ts", "export const toggle = 1;\n");
  put("src/shared/metrics/track.ts", `${"export const x = 1;\n".repeat(TOO_BIG.lines)}`);
  put("tests/orders.test.ts", "test\n");
  put("secrets/key.ts", "export const k = 1;\n");
  put(".jarvis/knowledge/orders.md", '---\npaths: ["src/orders/**"]\n---\n# Orders\n');
  put(
    ".jarvis/knowledge/design.md",
    '---\npaths: ["src/orders/**", "src/shared/**"]\n---\n# Design system\n',
  );
  put(
    ".jarvis/knowledge/module-api.md",
    `---\npaths: ["src/shared/api/**"]\n---\n${MODULE_MARKER}\n# Module\n`,
  );
  put("documentation/upload/index.md", "# Upload\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => sb.cleanup());

describe("the module tree", () => {
  it("lists source modules and their folders with size; tests and denied paths stay out", async () => {
    const tree = await moduleTree(roots());
    // files right under src make a module of their own; src/orders is still found
    expect(tree.modules.map((m) => m.path)).toEqual(["src", "src/orders", "src/shared"]);
    expect(findNode(tree, "src/shared/api")?.files).toBe(1);
    const shared = findNode(tree, "src/shared");
    expect(shared?.children.map((c) => c.path)).toEqual([
      "src/shared/api",
      "src/shared/metrics",
      "src/shared/upload",
    ]);
    expect(findNode(tree, "src/orders")?.files).toBe(2);
    expect(tree.dirs).toContain("src/orders/form");
    expect(tree.dirs.some((d) => d.startsWith("secrets") || d.startsWith("tests"))).toBe(false);
  });

  it("says what is too big for one pass (files or lines over the threshold)", async () => {
    const tree = await moduleTree(roots());
    expect(findNode(tree, "src/shared/metrics")?.tooBig).toBe(true);
    expect(findNode(tree, "src/shared")?.tooBig).toBe(true);
    expect(findNode(tree, "src/orders")?.tooBig).toBe(false);
  });

  it("finds the knowledge of a folder: own, generated, wider, the team's; and what may be stale", async () => {
    let tree = await moduleTree(roots());
    expect(findNode(tree, "src/orders")?.coverage).toMatchObject({
      kind: "document",
      doc: ".jarvis/knowledge/orders.md",
    });
    // a document about a folder is not the document of the folders inside it, unless it maps a module
    expect(findNode(tree, "src/orders/form")?.coverage).toBeUndefined();
    expect(findNode(tree, "src/orders/form")?.also).toContain(".jarvis/knowledge/orders.md");
    // a wide document (two modules) covers nothing, it is listed as applying
    expect(findNode(tree, "src/shared")?.coverage).toBeUndefined();
    expect(findNode(tree, "src/shared/metrics")?.also).toContain(".jarvis/knowledge/design.md");
    expect(findNode(tree, "src/shared/api")?.coverage).toMatchObject({ kind: "generated" });
    put("src/shared/api/v2/client.ts", "export const v2 = {};\n");
    git("add", "-A");
    git("commit", "-q", "-m", "api v2");
    expect(findNode(tree, "src/shared/upload")?.coverage).toMatchObject({ kind: "document", source: true });
    expect(findNode(tree, "src/shared/metrics")?.coverage).toBeUndefined();
    expect(findNode(tree, "src/orders")?.coverage?.staleCommits).toBeUndefined();

    put("src/orders/order.ts", "export class Order { total() { return 1; } }\n");
    git("commit", "-q", "-am", "orders: totals");
    tree = await moduleTree(roots());
    expect(findNode(tree, "src/orders")?.coverage?.staleCommits).toBe(1);
    // a module map covers the folders inside its module
    expect(findNode(tree, "src/shared/api/v2")?.coverage).toMatchObject({
      kind: "via",
      doc: ".jarvis/knowledge/module-api.md",
    });
  });
});
