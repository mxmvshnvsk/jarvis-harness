import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moduleFileId, sameModuleDoc } from "../../src/app/candidates.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("a module map's file", () => {
  it("is named by the whole folder; a very long one keeps its start and a hash", () => {
    // pilot: cut at 48 characters, «…-container-online-bank-» and «…-switc»
    expect(moduleFileId("shop-lib/pages/container-online-bank-account-docs-presign")).toBe(
      "module-shop-lib-pages-container-online-bank-account-docs-presign",
    );
    const long = `shop-lib/${"very-long-folder-name/".repeat(8)}end`;
    const id = moduleFileId(long);
    expect(id.length).toBeLessThanOrEqual("module-".length + 96);
    expect(id).toMatch(/^module-shop-lib-very-long-folder-name-.*-[0-9a-f]{6}$/);
    expect(moduleFileId(`${long}-2`)).not.toBe(id);
  });

  it("the same module's document is found under any name, by its paths", () => {
    dir = mkdtempSync(join(tmpdir(), "kn-"));
    mkdirSync(dir, { recursive: true });
    const doc = (paths: string) => `---\ntags: [module, generated]\npaths: ["${paths}"]\n---\n# Module\n`;
    writeFileSync(
      join(dir, "module-shop-lib-pages-container-online-bank-.md"),
      doc("shop-lib/pages/bank/**"),
    );
    writeFileSync(join(dir, "module-other.md"), doc("shop-lib/pages/bank/inner/**"));
    writeFileSync(join(dir, "notes.md"), doc("shop-lib/pages/bank/**"));
    expect(sameModuleDoc(dir, "shop-lib/pages/bank")).toBe(
      join(dir, "module-shop-lib-pages-container-online-bank-.md"),
    );
    expect(sameModuleDoc(dir, "shop-lib/pages")).toBeUndefined();
  });
});
