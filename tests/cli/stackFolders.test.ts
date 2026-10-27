import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { loadSkills } from "../../src/knowledge/skills.ts";
import { loadStandards } from "../../src/knowledge/standards.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Standards and skills of a knowledge repository by stack folders (pilot: Java rules reached the frontend). */
let sb: Sandbox;
const meta = () => join(sb.root, "shop-knowledge");

const std = (id: string, extra = "") => `---\nid: ${id}\ntitle: '${id}'\n${extra}---\nThe rule.\n`;
const skill = (id: string, applies = "") =>
  [`id: ${id}\nversion: 1\n${applies}`, `How to do ${id}.\n`] as const;

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("shop-knowledge/project.yaml", "version: 1\nservices:\n  orders-api: {}\n  shop-ui: {}\n");
  sb.write("shop-knowledge/standards/java/_scope.yaml", "stacks: [java]\n");
  sb.write("shop-knowledge/standards/java/java-01-naming.md", std("java-01-naming"));
  sb.write("shop-knowledge/standards/frontend/_scope.yaml", "scope: { stacks: [react, typescript] }\n");
  sb.write("shop-knowledge/standards/frontend/fe-01-hooks.md", std("fe-01-hooks"));
  // a file's own scope wins over its folder's
  sb.write(
    "shop-knowledge/standards/frontend/fe-02-styles.md",
    std("fe-02-styles", "scope: { stacks: [react], paths: ['src/**/*.css'] }\n"),
  );
  sb.write("shop-knowledge/standards/common/_scope.yaml", "# everyone, on purpose\n");
  sb.write("shop-knowledge/standards/common/commits.md", std("commits"));
  sb.write("shop-knowledge/standards/loose.md", std("loose"));
  for (const [dir, id, applies] of [
    ["java", "kafka", ""],
    ["frontend", "redux-saga", "appliesTo: { kinds: [feature] }\n"],
    ["", "docker", ""],
  ] as const) {
    const [manifest, instructions] = skill(id, applies);
    sb.write(`shop-knowledge/skills/${dir ? `${dir}/` : ""}${id}/skill.yaml`, manifest);
    sb.write(`shop-knowledge/skills/${dir ? `${dir}/` : ""}${id}/instructions.md`, instructions);
  }
  sb.write("shop-knowledge/skills/java/_scope.yaml", "stacks: [java]\n");
  sb.write("shop-knowledge/skills/frontend/_scope.yaml", "appliesTo: { stacks: [react] }\n");
  sb.write("orders-api/build.gradle", "plugins { id 'java' }\n");
  sb.write(
    "shop-ui/package.json",
    JSON.stringify({ dependencies: { react: "18" }, devDependencies: { typescript: "5" } }),
  );
  for (const d of ["shop-knowledge", "orders-api", "shop-ui"]) {
    mkdirSync(join(sb.root, d), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: join(sb.root, d) });
  }
});
afterEach(() => sb.cleanup());

async function jarvis(args: string[], cwd = meta()) {
  let out = "";
  let err = "";
  const sink = (add: (s: string) => void) =>
    new Writable({
      write(c, _e, cb) {
        add(String(c));
        cb();
      },
    });
  const code = await run(["node", "jarvis", ...args], {
    streams: { out: sink((s) => (out += s)), err: sink((s) => (err += s)) },
    context: { cwd, homeDir: sb.home, env: { PATH: process.env.PATH ?? "" } },
  });
  return { code, out, err };
}

describe("standards and skills by stack folders", () => {
  it("a folder's _scope.yaml fills what a file leaves empty; subfolders are read", async () => {
    // the knowledge repository's layout is known once its configuration is loaded
    await loadConfig({ cwd: meta(), homeDir: sb.home, env: {} });
    const standards = loadStandards({ projectRoot: meta() });
    const by = Object.fromEntries(standards.map((s) => [s.id, s]));
    expect(by["java-01-naming"]?.scope.stacks).toEqual(["java"]);
    expect(by["java-01-naming"]?.group).toBe("java");
    expect(by["fe-01-hooks"]?.scope.stacks).toEqual(["react", "typescript"]);
    expect(by["fe-02-styles"]?.scope).toMatchObject({ stacks: ["react"], paths: ["src/**/*.css"] });
    expect(by.commits).toMatchObject({ folderScoped: true, scope: { stacks: [] } });
    expect(by.loose?.folderScoped).toBeUndefined();
    const skills = Object.fromEntries(
      loadSkills({ projectRoot: meta() })
        .filter((s) => s.level === "project")
        .map((s) => [s.id, s]),
    );
    expect(skills.kafka?.appliesTo.stacks).toEqual(["java"]);
    expect(skills["redux-saga"]?.appliesTo).toMatchObject({ stacks: ["react"], kinds: ["feature"] });
    expect(skills.docker?.appliesTo.stacks).toEqual([]);
  });

  it("a service gets what its stack is for; what names no stack is said", async () => {
    const ui = await jarvis(["standards", "list", "--service", "shop-ui"]);
    expect(ui.code).toBe(0);
    expect(ui.out).toContain("shop-ui (stacks: node, react, typescript) gets 4 of 5 standard(s)");
    expect(ui.out).not.toContain("java-01-naming");
    expect(ui.out).toContain("fe-01-hooks");
    expect(ui.out).toContain("1 standard(s) name no stack (loose)");
    const api = await jarvis(["--json", "standards", "list", "--service", "orders-api"]);
    const ids = (JSON.parse(api.out) as { standards: Array<{ id: string }> }).standards.map((s) => s.id);
    expect(ids.sort()).toEqual(["commits", "java-01-naming", "loose"]);
    const skills = await jarvis(["skills", "list", "--service", "shop-ui"]);
    expect(skills.out).toContain("shop-ui — stacks: node, react, typescript");
    expect(skills.out).toContain("1 skill(s) name no stack (docker)");
    const doctor = await jarvis(["--json", "doctor"]);
    const checks = (JSON.parse(doctor.out) as { checks: Array<{ id: string; detail: string }> }).checks;
    expect(checks.find((c) => c.id === "knowledge.unscoped")?.detail).toContain("loose, docker");
    expect((await jarvis(["standards", "list", "--service", "nope"])).code).toBe(1);
  });
});
