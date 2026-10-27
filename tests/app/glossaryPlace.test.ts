import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conflictOf, glossaryScopesOf, placeTerm, settleTerm } from "../../src/app/glossaryPlace.ts";
import { forgetLayouts, metaProjectPaths, rememberLayout } from "../../src/core/paths.ts";
import { glossaryDuplicates, loadGlossaries, symbolOf, termKey } from "../../src/knowledge/glossaries.ts";

const HEAD = "| term | synonyms | symbols | sources | updated | definition |\n|---|---|---|---|---|---|\n";
const today = new Date("2026-01-02T00:00:00Z");

let meta: string;
let shop: string;
let orders: string;

const file = (...p: string[]) => join(meta, "knowledge", ...p);
const write = (rel: string[], rows: string) => {
  mkdirSync(join(file(...rel), ".."), { recursive: true });
  writeFileSync(file(...rel), `# Glossary\n\n${HEAD}${rows}`);
};
const read = (...rel: string[]) => readFileSync(file(...rel), "utf8");
const term = (name: string, symbols: string[] = []) => ({
  term: name,
  synonyms: [],
  symbols,
  sources: [],
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "gloss-"));
  meta = join(base, "knowledge-repo");
  shop = join(base, "shop-web");
  orders = join(base, "orders-api");
  for (const d of [meta, shop, orders]) mkdirSync(d, { recursive: true });
  writeFileSync(
    join(meta, "project.yaml"),
    "services:\n  shop-web:\n    uses: [common-lib]\n  orders-api: {}\n  common-lib: {}\n",
  );
  write(
    ["glossary.md"],
    "| Order | purchase | `orders-api:OrderEntity` |  | 2026-01-01 | A customer's purchase |\n",
  );
  forgetLayouts();
  rememberLayout(metaProjectPaths(meta, meta, undefined));
  rememberLayout(metaProjectPaths(shop, meta, "shop-web"));
  rememberLayout(metaProjectPaths(orders, meta, "orders-api"));
});

afterEach(() => {
  forgetLayouts();
  rmSync(join(meta, ".."), { recursive: true, force: true });
});

describe("glossary keys", () => {
  it("same term regardless of case, brackets and ё", () => {
    expect(termKey("Заказ (order/item)")).toBe(termKey("заказ"));
    expect(termKey("Ёлка")).toBe(termKey("елка"));
  });

  it("a symbol said by service", () => {
    expect(symbolOf("orders-api:OrderEntity")).toEqual({ service: "orders-api", name: "OrderEntity" });
    expect(symbolOf("std::vector")).toEqual({ name: "std::vector" });
    expect(symbolOf("C:\\code")).toEqual({ name: "C:\\code" });
  });
});

describe("which glossaries a run reads", () => {
  it("a service: the shared, its own and its libraries'", () => {
    write(["services", "shop-web", "glossary.md"], "| Cart | basket | `CartStore` |  | 2026-01-01 |  |\n");
    write(["services", "common-lib", "glossary.md"], "| Button |  | `Button` |  | 2026-01-01 |  |\n");
    write(["services", "orders-api", "glossary.md"], "| Invoice |  | `Invoice` |  | 2026-01-01 |  |\n");
    const scopes = loadGlossaries(shop).map((e) => `${e.scope}/${e.term}`);
    expect(scopes).toEqual(["shared/Order", "shop-web/Cart", "common-lib/Button"]);
    expect(loadGlossaries(meta).map((e) => e.scope)).toEqual([
      "shared",
      "common-lib",
      "orders-api",
      "shop-web",
    ]);
  });

  it("a person adds to the service's or the shared glossary", () => {
    mkdirSync(file("services", "shop-web"), { recursive: true });
    expect(glossaryScopesOf(shop)).toEqual(["shop-web", "shared"]);
    expect(glossaryScopesOf(meta)).toEqual(["shared", "shop-web"]);
  });
});

describe("placing a term", () => {
  it("a new term goes to the service's glossary", () => {
    const p = placeTerm(shop, term("Cart", ["CartStore"]), undefined, { today });
    expect(p).toMatchObject({ placed: "added", scope: "shop-web" });
    expect(read("services", "shop-web", "glossary.md")).toContain("| Cart |");
  });

  it("a term the shared glossary has gets the service's symbols, said by service", () => {
    const p = placeTerm(shop, term("order", ["OrderCard"]), undefined, { today });
    expect(p).toMatchObject({ placed: "extended", scope: "shared", term: "Order" });
    expect(read("glossary.md")).toContain("`shop-web:OrderCard`");
  });

  it("another service's term waits for a person", () => {
    write(
      ["services", "orders-api", "glossary.md"],
      "| Invoice | bill | `Invoice` |  | 2026-01-01 | A bill |\n",
    );
    expect(conflictOf(shop, { term: "Invoice", synonyms: [] })).toBe("orders-api");
    const p = placeTerm(shop, term("bill", ["InvoiceView"]), undefined, { today });
    expect(p).toEqual({ conflict: { scope: "orders-api", term: "Invoice" }, scope: "shop-web" });
  });

  it("one sense: the term moves to the shared glossary with both services' symbols", () => {
    write(
      ["services", "orders-api", "glossary.md"],
      "| Invoice | bill | `Invoice` |  | 2026-01-01 | A bill |\n",
    );
    settleTerm(shop, term("Invoice", ["InvoiceView"]), "shop-web", "orders-api", "shared", today);
    const shared = read("glossary.md");
    expect(shared).toContain("`orders-api:Invoice`");
    expect(shared).toContain("`shop-web:InvoiceView`");
    expect(read("services", "orders-api", "glossary.md")).not.toContain("| Invoice |");
    expect(glossaryDuplicates(loadGlossaries(meta))).toEqual([]);
  });

  it("two senses: each service keeps its row, the shared glossary says it is a homonym", () => {
    write(
      ["services", "orders-api", "glossary.md"],
      "| Status |  | `OrderStatus` |  | 2026-01-01 | Of an order |\n",
    );
    settleTerm(shop, term("Status", ["BadgeStatus"]), "shop-web", "orders-api", "homonym", today);
    expect(read("glossary.md")).toMatch(/\| Status \|.*homonym — orders-api: Of an order; shop-web: Status/);
    expect(read("services", "shop-web", "glossary.md")).toContain("`BadgeStatus`");
    expect(glossaryDuplicates(loadGlossaries(meta))).toEqual([]);
    // a third service with the same word: its own sense, no question
    mkdirSync(file("services", "common-lib"), { recursive: true });
    rememberLayout(metaProjectPaths(join(meta, "..", "common-lib"), meta, "common-lib"));
    const p = placeTerm(join(meta, "..", "common-lib"), term("Status", ["StatusDot"]), undefined, { today });
    expect(p).toMatchObject({ placed: "added", scope: "common-lib" });
  });

  it("the same term in the shared and a service's glossary is a duplicate", () => {
    write(["services", "shop-web", "glossary.md"], "| Order |  | `OrderCard` |  | 2026-01-01 |  |\n");
    expect(glossaryDuplicates(loadGlossaries(meta))).toEqual([
      { term: "Order", scopes: ["shared", "shop-web"] },
    ]);
  });
});
