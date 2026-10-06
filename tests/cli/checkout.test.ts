import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Change, editorFor, homePath, watchCheckout } from "../../src/cli/checkout.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("the editor a checkout opens in", () => {
  it("JARVIS_EDITOR first, with its arguments", () => {
    expect(editorFor({ JARVIS_EDITOR: "code -n" })).toEqual({ command: ["code", "-n"], label: "VS Code" });
    expect(editorFor({ JARVIS_EDITOR: "/opt/bin/webstorm" })).toEqual({
      command: ["/opt/bin/webstorm"],
      label: "WebStorm",
    });
  });

  it("then a known editor on PATH, then an editor app (macOS), then the file manager", () => {
    const bin = join(sb.root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "idea"), "");
    expect(editorFor({ PATH: bin }, { platform: "linux" })).toEqual({
      command: ["idea"],
      label: "IntelliJ IDEA",
    });
    mkdirSync(join(sb.home, "Applications", "WebStorm.app"), { recursive: true });
    expect(editorFor({ PATH: "" }, { platform: "darwin", home: sb.home })).toEqual({
      command: ["open", "-a", "WebStorm"],
      label: "WebStorm",
    });
    expect(editorFor({ PATH: "" }, { platform: "darwin", home: join(sb.root, "nohome") })?.label).toBe(
      "Finder",
    );
    expect(editorFor({ PATH: "" }, { platform: "linux" })).toBeUndefined();
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
