import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clientModule, GENERATED } from "../../scripts/build-client.ts";
import { SCRIPT } from "../../src/ui/client.gen.ts";

describe("the page's script", () => {
  it("is what src/ui/client/ makes: src/ui/client.gen.ts is not stale (pnpm build:client)", async () => {
    expect(readFileSync(GENERATED, "utf8")).toBe(await clientModule());
  });

  it("parses as a classic script, with the morphing library inside", () => {
    expect(() => new Function(SCRIPT)).not.toThrow();
    expect(SCRIPT).toContain("Idiomorph");
    expect(SCRIPT).not.toMatch(/^\s*(import|export)\s/m);
  });
});
