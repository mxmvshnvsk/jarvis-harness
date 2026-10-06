import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUi } from "../../src/cli/commands/ui.ts";
import { defaultContext } from "../../src/cli/context.ts";
import { createOutput } from "../../src/cli/output.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
});
afterEach(() => sb.cleanup());

describe("jarvis ui", () => {
  it("prints the address with its token, opens the browser when asked, serves the page", async () => {
    let out = "";
    const sink = new Writable({
      write(c, _e, cb) {
        out += String(c);
        cb();
      },
    });
    const ctx = defaultContext(createOutput(false, { out: sink, err: sink }, { color: false }), {
      cwd: sb.project,
      homeDir: sb.home,
      env: { PATH: process.env.PATH ?? "" },
    });
    const opened: string[] = [];
    let status = 0;
    await runUi(ctx, {
      port: 0,
      open: true,
      browser: (url) => {
        opened.push(url);
        return true;
      },
      until: async (server) => {
        const page = await fetch(server.url, { redirect: "manual" });
        status = page.status;
      },
    });
    expect(out).toMatch(/jarvis ui {2}http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]{20,}/);
    expect(out).toContain("opened in your browser");
    expect(opened).toHaveLength(1);
    expect(status).toBe(303); // the token becomes a cookie
  });
});
