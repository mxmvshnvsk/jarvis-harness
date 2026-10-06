import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { createStyle } from "../../src/cli/style.ts";
import { artifactLink, viewFile } from "../../src/cli/view.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;
beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

describe("artifacts as files a click opens", () => {
  it("renders an agent's document as markdown once per version, and links it where the terminal can", () => {
    const run = createRun(rt, "smoke");
    const a = rt.artifacts.put({
      runId: run.id,
      type: "spec",
      name: "spec.json",
      content: JSON.stringify({
        title: "Hide the delivery block",
        summary: "Compact mode shows only three sections.",
      }),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "artifact.write" },
    });
    const file = viewFile(rt, a) as string;
    expect(file).toMatch(/view\/run_[0-9a-f]+\/spec-spec@1\.md$/);
    expect(readFileSync(file, "utf8")).toContain("# Hide the delivery block");
    const linked = artifactLink(createStyle(true, { links: true }), rt, a, "spec.json");
    expect(linked).toBe(`\u001b]8;;${pathToFileURL(file).href}\u0007spec.json\u001b]8;;\u0007`);
    expect(artifactLink(createStyle(true), rt, a, "spec.json")).toBe("spec.json");
  });
});
