import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Change,
  describeFiles,
  type EditorKind,
  editorFor,
  homePath,
  openCommand,
  reviewFiles,
  watchCheckout,
} from "../../src/cli/checkout.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("the editor a checkout opens in", () => {
  it("JARVIS_EDITOR first, with its arguments", () => {
    expect(editorFor({ JARVIS_EDITOR: "code -n" })).toEqual({
      command: ["code", "-n"],
      label: "VS Code",
      kind: "vscode",
    });
    expect(editorFor({ JARVIS_EDITOR: "/opt/bin/webstorm" })).toEqual({
      command: ["/opt/bin/webstorm"],
      label: "WebStorm",
      kind: "jetbrains",
    });
    expect(editorFor({ JARVIS_EDITOR: "pycharm" })?.kind).toBe("jetbrains");
    expect(editorFor({ JARVIS_EDITOR: "nvim-qt" })?.kind).toBe("paths");
  });

  it("then a known editor on PATH or in Toolbox scripts, then an app's launcher (macOS), then the file manager", () => {
    const bin = join(sb.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "idea"), "");
    expect(editorFor({ PATH: bin }, { platform: "linux" })).toEqual({
      command: [join(bin, "idea")],
      label: "IntelliJ IDEA",
      kind: "jetbrains",
    });
    const toolbox = join(sb.home, "Library/Application Support/JetBrains/Toolbox/scripts");
    mkdirSync(toolbox, { recursive: true });
    writeFileSync(join(toolbox, "webstorm"), "");
    expect(editorFor({ PATH: "" }, { platform: "darwin", home: sb.home })?.command).toEqual([
      join(toolbox, "webstorm"),
    ]);
    const other = join(sb.root, "other");
    const app = join(other, "Applications", "WebStorm.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    expect(editorFor({ PATH: "" }, { platform: "darwin", home: other })).toEqual({
      command: ["open", "-a", "WebStorm"],
      label: "WebStorm",
      kind: "paths",
    });
    writeFileSync(join(app, "Contents/MacOS/webstorm"), "");
    expect(editorFor({ PATH: "" }, { platform: "darwin", home: other })).toEqual({
      command: [join(app, "Contents/MacOS/webstorm")],
      label: "WebStorm",
      kind: "jetbrains",
    });
    expect(editorFor({ PATH: "" }, { platform: "darwin", home: join(sb.root, "nohome") })?.label).toBe(
      "Finder",
    );
    expect(editorFor({ PATH: "" }, { platform: "linux" })).toBeUndefined();
  });

  it("opens the folder with the files at their lines, as each editor takes them", () => {
    const files = [{ path: "/w/a.test.ts", line: 113 }, { path: "/w/b.ts" }];
    const ed = (kind: EditorKind) => ({ command: ["ed"], label: "ed", kind });
    expect(openCommand(ed("vscode"), "/w", files)).toEqual(["ed", "/w", "-g", "/w/a.test.ts:113", "/w/b.ts"]);
    expect(openCommand(ed("vscode"), "/w")).toEqual(["ed", "/w"]);
    expect(openCommand(ed("jetbrains"), "/w", files)).toEqual([
      "ed",
      "/w",
      "--line",
      "113",
      "/w/a.test.ts",
      "/w/b.ts",
    ]);
    expect(openCommand(ed("colon"), "/w", files)).toEqual(["ed", "/w", "/w/a.test.ts:113", "/w/b.ts"]);
    expect(openCommand(ed("paths"), "/w", files)).toEqual(["ed", "/w", "/w/a.test.ts", "/w/b.ts"]);
    expect(openCommand(ed("folder"), "/w", files)).toEqual(["ed", "/w"]);
    expect(describeFiles(files)).toBe("a.test.ts:113, b.ts");
    expect(describeFiles([...files, { path: "/w/c.ts" }])).toBe("a.test.ts:113, b.ts +1");
  });

  it("shows paths under the home as ~", () => {
    expect(homePath("/Users/me/.jarvis/worktrees/web-app/1a2b", "/Users/me")).toBe(
      "~/.jarvis/worktrees/web-app/1a2b",
    );
    expect(homePath("/srv/x", "/Users/me")).toBe("/srv/x");
  });
});

describe("the card watches the checkout", () => {
  it("reports a change once, when the set of changed files differs", async () => {
    let now: Change[] = [];
    const seen: string[] = [];
    const stop = watchCheckout("/x", (c) => seen.push(c.map((x) => `${x.code} ${x.file}`).join(",")), {
      everyMs: 5,
      read: () => now,
    });
    await new Promise((r) => setTimeout(r, 30));
    now = [{ code: "D", file: "tmp-a.txt" }];
    await new Promise((r) => setTimeout(r, 30));
    now = [
      { code: "D", file: "tmp-a.txt" },
      { code: "M", file: "src/a.test.ts" },
    ];
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(seen).toEqual(["D tmp-a.txt", "D tmp-a.txt,M src/a.test.ts"]);
  });
});

describe("the files to review", () => {
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

  it("the files the reasons name first, at their lines, then the changed ones by size at their first change", () => {
    const dir = sb.project;
    mkdirSync(join(dir, "src/form/__tests__"), { recursive: true });
    writeFileSync(join(dir, "src/form/Toggle.tsx"), "a\nb\nc\nd\n");
    writeFileSync(join(dir, "src/form/gone.ts"), "x\n");
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const base = git(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "src/form/Toggle.tsx"), "a\nb\nC\nd\ne\nf\ng\n");
    writeFileSync(join(dir, "src/form/__tests__/toggle.test.tsx"), "t\n");
    writeFileSync(join(dir, "tmp-probe.txt"), "abc\n");
    git(dir, ["rm", "-q", "src/form/gone.ts"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "run"]);
    const files = reviewFiles(
      dir,
      base,
      "lint_error: eol-last: …/__tests__/toggle.test.tsx:113 — no newline; see a.md",
    );
    expect(files).toEqual([
      { path: join(dir, "src/form/__tests__/toggle.test.tsx"), line: 113 },
      { path: join(dir, "src/form/Toggle.tsx"), line: 3 },
    ]);
    expect(reviewFiles(dir, undefined)).toEqual([]);
  });
});
