import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ModuleMapDoc, verifyModuleMap } from "../../src/onboarding/verify.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  sb.write(
    "project/src/orders/order.ts",
    [
      "export class Order {",
      "  total(): number {",
      "    // discounts are applied before tax",
      "    return applyTax(applyDiscounts(this.lines));",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  sb.write("project/.env", "TOKEN=abc\n");
});
afterEach(() => sb.cleanup());

const doc = (over: Partial<ModuleMapDoc>): ModuleMapDoc => ({
  module: "src/orders",
  purpose: "Orders",
  publicApi: [],
  responsibilities: [],
  rules: [],
  terms: [],
  unknowns: [],
  ...over,
});

describe("verifyModuleMap", () => {
  it("keeps a claim whose excerpt is in the file and corrects its line", () => {
    const out = verifyModuleMap(
      doc({
        rules: [
          {
            statement: "Discounts come before tax",
            evidence: [
              { file: "src/orders/order.ts", line: 99, quote: "applyTax(applyDiscounts(this.lines))" },
            ],
          },
        ],
      }),
      { root: sb.project },
    );
    expect(out.rules).toHaveLength(1);
    expect(out.rules[0]?.evidence[0]).toMatchObject({ file: "src/orders/order.ts", line: 4 });
    expect(out.dropped).toEqual([]);
  });

  it("matches excerpts regardless of whitespace", () => {
    const out = verifyModuleMap(
      doc({
        rules: [
          {
            statement: "s",
            evidence: [{ file: "src/orders/order.ts", quote: "// discounts   are applied\tbefore tax" }],
          },
        ],
      }),
      { root: sb.project },
    );
    expect(out.rules).toHaveLength(1);
  });

  it("drops claims with an invented excerpt, a missing file, a path outside the repo or a denied file", () => {
    const out = verifyModuleMap(
      doc({
        responsibilities: [
          {
            statement: "invented",
            evidence: [{ file: "src/orders/order.ts", quote: "return cache.get(id)" }],
          },
          { statement: "missing", evidence: [{ file: "src/orders/nope.ts", quote: "anything" }] },
          { statement: "outside", evidence: [{ file: "../secret.txt", quote: "anything" }] },
          { statement: "absolute", evidence: [{ file: "/etc/passwd", quote: "root" }] },
          { statement: "denied", evidence: [{ file: ".env", quote: "TOKEN=abc" }] },
        ],
      }),
      { root: sb.project, isDenied: (rel) => rel === ".env" },
    );
    expect(out.responsibilities).toEqual([]);
    expect(out.dropped.map((d) => d.what)).toEqual(["invented", "missing", "outside", "absolute", "denied"]);
  });

  it("keeps a claim when at least one of its evidence items holds", () => {
    const out = verifyModuleMap(
      doc({
        rules: [
          {
            statement: "mixed",
            evidence: [
              { file: "src/orders/order.ts", quote: "this is made up" },
              { file: "src/orders/order.ts", quote: "export class Order {" },
            ],
          },
        ],
      }),
      { root: sb.project },
    );
    expect(out.rules[0]?.evidence).toHaveLength(1);
  });

  it("checks public API symbols and term symbols against the files", () => {
    const out = verifyModuleMap(
      doc({
        publicApi: [
          { symbol: "Order", file: "src/orders/order.ts", description: "the aggregate" },
          { symbol: "Ghost", file: "src/orders/order.ts", description: "not there" },
        ],
        terms: [
          { term: "order", synonyms: ["purchase"], symbols: ["Order", "Ghost"] },
          { term: "phantom", synonyms: [], symbols: ["Nothing"] },
          { term: "vocabulary only", synonyms: [], symbols: [] },
        ],
      }),
      { root: sb.project },
    );
    expect(out.publicApi.map((a) => [a.symbol, a.line])).toEqual([["Order", 1]]);
    expect(out.terms.map((t) => [t.term, t.symbols])).toEqual([
      ["order", ["Order"]],
      ["vocabulary only", []],
    ]);
    expect(out.dropped.map((d) => d.what).sort()).toEqual(["Ghost", "phantom"]);
  });

  it("finds symbols that start or end with punctuation — package names and export paths (pilot)", () => {
    sb.write(
      "project/packages/shared/package.json",
      [
        "{",
        '    "name": "@repo/shared",',
        '    "exports": {',
        '        "./eslint-config/*": "./eslint-config/*"',
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    const out = verifyModuleMap(
      doc({
        module: "packages/shared",
        publicApi: [
          { symbol: "./eslint-config/*", file: "packages/shared/package.json", description: "eslint" },
          { symbol: "./jest-config/*", file: "packages/shared/package.json", description: "absent" },
        ],
        terms: [{ term: "shared config package", synonyms: [], symbols: ["@repo/shared"] }],
      }),
      { root: sb.project },
    );
    expect(out.publicApi.map((a) => [a.symbol, a.line])).toEqual([["./eslint-config/*", 4]]);
    expect(out.terms.map((t) => t.term)).toEqual(["shared config package"]);
    expect(out.dropped.map((d) => d.what)).toEqual(["./jest-config/*"]);
  });

  it("still matches a plain identifier only as a whole word", () => {
    const out = verifyModuleMap(
      doc({
        publicApi: [
          { symbol: "Order", file: "src/orders/order.ts", description: "the order" },
          { symbol: "Ord", file: "src/orders/order.ts", description: "a prefix only" },
        ],
      }),
      { root: sb.project },
    );
    expect(out.publicApi.map((a) => a.symbol)).toEqual(["Order"]);
    expect(out.dropped.map((d) => d.what)).toEqual(["Ord"]);
  });
});
