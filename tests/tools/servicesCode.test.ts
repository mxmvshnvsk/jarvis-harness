import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetLayouts, metaProjectPaths, rememberLayout } from "../../src/core/paths.ts";
import { ServicesCodeProvider, servesServicesCode } from "../../src/tools/servicesCode.ts";
import type { ToolContext } from "../../src/tools/types.ts";

let base: string;
let meta: string;

const ctxAt = (workspacePath: string) =>
  ({
    workspacePath,
    pathPolicy: { isDenied: (p: string) => p.startsWith("secret") },
  }) as unknown as ToolContext;
const tool = (name: string) => {
  const c = new ServicesCodeProvider().capabilities().find((x) => x.name === name);
  if (!c) throw new Error(name);
  return c;
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "svc-code-"));
  meta = join(base, "knowledge-repo");
  mkdirSync(meta);
  writeFileSync(
    join(meta, "project.yaml"),
    "services:\n  shop-web: {}\n  orders-api: {}\n  billing-api: {}\n",
  );
  for (const [svc, files] of Object.entries({
    "shop-web": { "src/banner.ts": "export const showGiftBanner = true;\n", "secret.ts": "showGiftBanner\n" },
    "orders-api": { "src/Order.java": "class Order { boolean giftBanner; }\n" },
  })) {
    const dir = join(base, svc);
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
  }
  forgetLayouts();
  rememberLayout(metaProjectPaths(meta, meta, undefined));
  rememberLayout(metaProjectPaths(join(base, "shop-web"), meta, "shop-web"));
});
afterEach(() => {
  forgetLayouts();
  rmSync(base, { recursive: true, force: true });
});

describe("the services' code from the knowledge repository", () => {
  it("only the knowledge repository itself, not a service's run", () => {
    expect(servesServicesCode(meta)).toBe(true);
    expect(servesServicesCode(join(base, "shop-web"))).toBe(false);
  });

  it("one search across the cloned services, hits said by service", async () => {
    const r = await tool("services.search").handler({ pattern: "(?i)GIFTBANNER" }, ctxAt(meta));
    expect(r.ok).toBe(true);
    expect(r.text).toContain("2 hit(s): orders-api 1, shop-web 1");
    expect(r.text).toContain("shop-web:src/banner.ts:1:export const showGiftBanner = true;");
    expect(r.text).toContain("orders-api:src/Order.java:1:");
    // a denied path is not shown; a service not cloned here is said
    expect(r.text).not.toContain("secret.ts");
    const only = await tool("services.search").handler(
      { pattern: "giftBanner", literal: true, services: ["orders-api", "billing-api"] },
      ctxAt(meta),
    );
    expect(only.text).toContain("orders-api:src/Order.java:1:");
    expect(only.text).toContain("not cloned here or not of the map: billing-api");
  });

  it("reads a file of a service, inside its clone only", async () => {
    const r = await tool("services.read").handler(
      { service: "shop-web", path: "src/banner.ts" },
      ctxAt(meta),
    );
    expect(r.text).toBe("shop-web:src/banner.ts (2 lines)\n1: export const showGiftBanner = true;\n2: ");
    expect(
      (
        await tool("services.read").handler(
          { service: "shop-web", path: "../orders-api/src/Order.java" },
          ctxAt(meta),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await tool("services.read").handler(
          { service: "shop-web", path: "src/banner.ts" },
          ctxAt(join(base, "shop-web")),
        )
      ).error,
    ).toContain("only in a task across services");
  });
});
