import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cacheKey,
  expandPaths,
  pruneDeps,
  restoreDeps,
  saveDeps,
} from "../../src/orchestration/depsCache.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("dependency cache", () => {
  it("keys on the content of the lockfiles", () => {
    sb.write("a/yarn.lock", "v1");
    sb.write("b/yarn.lock", "v1");
    const a = join(sb.root, "a");
    const b = join(sb.root, "b");
    expect(cacheKey(a, ["yarn.lock"])).toBe(cacheKey(b, ["yarn.lock"]));
    sb.write("b/yarn.lock", "v2");
    expect(cacheKey(a, ["yarn.lock"])).not.toBe(cacheKey(b, ["yarn.lock"]));
    expect(cacheKey(a, ["missing.lock"])).toHaveLength(16);
  });

  it("expands one-level wildcards to existing paths, not into node_modules or dot dirs", () => {
    for (const p of ["node_modules/x", "packages/a/node_modules/y", "packages/b/src", ".git/node_modules/z"])
      mkdirSync(join(sb.root, "repo", p), { recursive: true });
    expect(
      expandPaths(join(sb.root, "repo"), ["node_modules", "packages/*/node_modules", "*/node_modules"]),
    ).toEqual(["node_modules", "packages/a/node_modules"]);
  });

  it("saves, restores and keeps only the newest keys", async () => {
    const src = join(sb.root, "src");
    mkdirSync(join(src, "node_modules/dep"), { recursive: true });
    writeFileSync(join(src, "node_modules/dep/index.js"), "x");
    const dir = join(sb.root, "cache");
    expect(await saveDeps(dir, "k1", src, ["node_modules"])).toEqual(["node_modules"]);
    const dst = join(sb.root, "dst");
    mkdirSync(dst);
    expect(await restoreDeps(dir, "k1", dst)).toEqual(["node_modules"]);
    expect(readFileSync(join(dst, "node_modules/dep/index.js"), "utf8")).toBe("x");
    expect(await restoreDeps(dir, "nope", dst)).toBeUndefined();

    await saveDeps(dir, "k2", src, ["node_modules"]);
    await saveDeps(dir, "k3", src, ["node_modules"]);
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(dir, "k1", "manifest.json"), old, old);
    pruneDeps(dir, 2);
    expect(["k1", "k2", "k3"].map((k) => existsSync(join(dir, k)))).toEqual([false, true, true]);
  });
});
