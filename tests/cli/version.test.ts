import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInfoIn, checkoutHead, staleBuildIn, versionText } from "../../src/version.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const A = "a".repeat(40);
const B = "b".repeat(40);

function checkout(head: string, packed = false) {
  const root = join(sb.root, "jarvis");
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (packed) writeFileSync(join(root, ".git", "packed-refs"), `# pack-refs\n${head} refs/heads/main\n`);
  else writeFileSync(join(root, ".git", "refs", "heads", "main"), `${head}\n`);
  return root;
}

describe("build staleness", () => {
  it("reads the checkout's HEAD from loose and packed refs", () => {
    expect(checkoutHead(checkout(A))).toBe(A);
    sb.cleanup();
    sb = sandbox();
    expect(checkoutHead(checkout(B, true))).toBe(B);
    expect(checkoutHead(join(sb.root, "nowhere"))).toBeUndefined();
  });

  it("says when dist was built from another commit than the checkout", () => {
    const root = checkout(B);
    const dist = join(root, "dist");
    expect(staleBuildIn(dist, root)).toBeUndefined(); // no build info: running from source
    writeFileSync(
      join(dist, "build-info.json"),
      JSON.stringify({ commit: A, builtAt: "2026-10-06T12:00:00Z" }),
    );
    expect(buildInfoIn(dist)).toEqual({ commit: A, builtAt: "2026-10-06T12:00:00Z" });
    expect(staleBuildIn(dist, root)).toEqual({ built: A, head: B });
    writeFileSync(
      join(dist, "build-info.json"),
      JSON.stringify({ commit: B, builtAt: "2026-10-06T12:00:00Z" }),
    );
    expect(staleBuildIn(dist, root)).toBeUndefined();
  });

  it("names the source when not running a build", () => {
    expect(versionText()).toMatch(/^\d+\.\d+\.\d+ \(source\)$/);
  });
});
