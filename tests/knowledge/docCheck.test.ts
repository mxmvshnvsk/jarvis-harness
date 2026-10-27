import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkKnowledge,
  citedPath,
  citedSymbol,
  duplicatesOf,
  proseLanguageOf,
} from "../../src/knowledge/docCheck.ts";

let dir: string;
const put = (rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: dir })
    .toString()
    .trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kcheck-"));
  git("init", "-q", "-b", "main");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ENGLISH =
  "The orders module keeps the order aggregate and prices it before fees. It is used by the checkout and by the reports, and nothing else writes the totals. ".repeat(
    3,
  );

describe("jarvis knowledge check (pilot: 30 documents checked by hand)", () => {
  it("finds moved lines and puts them right, gone quotes, missing paths, copies and the wrong language", async () => {
    put(
      "src/orders/order.ts",
      [
        "// header",
        "",
        "export function priceOrder(n: number) {",
        "  return applyFees(n); // fees last",
        "}",
        "",
      ].join("\n"),
    );
    put("src/orders/extra.ts", "export const x = 1;\n");
    put("src/orders/index.ts", "export * from './order';\n");
    git("add", "-A");
    git("commit", "-q", "-m", "code");
    const at = git("rev-parse", "HEAD");
    const doc = [
      "---",
      'paths: ["src/orders/**"]',
      `commit: ${at}`,
      "---",
      "<!-- jarvis:onboard-module — mapped by an agent; every claim was checked against the code; edit freely -->",
      "# Module src/orders",
      "",
      ENGLISH,
      "",
      "- `priceOrder` (`src/orders/order.ts:1`) — prices an order.",
      "- Fees go last.",
      "  - `src/orders/order.ts:2`: `return applyFees(n); // fees last`",
      "- Discounts first.",
      "  - `src/orders/order.ts:4`: `applyDiscounts(n)`",
      "- See `src/orders/gone.ts`, `src/orders/extra.ts`, `@scope/pkg`, `/api/orders`, `GhostThing` and `formatTotal()`.",
      "- Not ours: `react-dom/server`, `login/password`, `metric_`; re-exported: `Order` (`src/orders/index.ts:1`).",
      "",
    ].join("\n");
    put(".jarvis/knowledge/module-src-orders.md", doc);
    put(".jarvis/knowledge/module-src-orders copy.md", doc);
    put("src/orders/order.ts", "// moved\n" + readFileSync(join(dir, "src/orders/order.ts"), "utf8"));
    git("add", "src");
    git("commit", "-q", "-m", "moved");

    const result = await checkKnowledge({ projectRoot: dir } as never, { language: "ru", tree: false });
    const d = result.docs.find((x) => x.doc === ".jarvis/knowledge/module-src-orders.md");
    expect(d).toBeDefined();
    expect(d?.moved).toBe(2);
    expect(d?.lost).toEqual([{ ref: "src/orders/order.ts:4", text: "applyDiscounts(n)" }]);
    expect(d?.missingPaths).toEqual(["src/orders/gone.ts"]);
    expect(d?.missingSymbols).toEqual(["GhostThing", "formatTotal"]);
    expect(d?.staleCommits).toBe(1);
    expect(d?.language).toEqual({ expected: "ru", found: "en" });
    expect(result.duplicates).toEqual([
      [".jarvis/knowledge/module-src-orders copy.md", ".jarvis/knowledge/module-src-orders.md"],
    ]);

    await checkKnowledge({ projectRoot: dir } as never, { fix: true, tree: false });
    const fixed = readFileSync(join(dir, ".jarvis/knowledge/module-src-orders.md"), "utf8");
    expect(fixed).toContain("(`src/orders/order.ts:4`) — prices an order.");
    expect(fixed).toContain("`src/orders/order.ts:5`: `return applyFees(n); // fees last`");
    // the gone quote is left for a person or a new map
    expect(fixed).toContain("`src/orders/order.ts:4`: `applyDiscounts(n)`");
  });

  it("tells paths and symbols from routes, packages, templates and words", () => {
    expect(citedPath("packages/lib/src/a.ts:12")).toBe("packages/lib/src/a.ts");
    for (const t of ["pkg:@scope/x", "/api/orders", "./a/b", "<app>/x", "src/{a,b}", "get/post/put", "a b/c"])
      expect([t, citedPath(t)]).toEqual([t, t === "get/post/put" ? "get/post/put" : undefined]);
    expect(citedSymbol("priceOrder")).toBe("priceOrder");
    expect(citedSymbol("OrderTotal")).toBe("OrderTotal");
    expect(citedSymbol("MAX_SIZE")).toBe("MAX_SIZE");
    expect(citedSymbol("build()")).toBe("build");
    expect(citedSymbol("build")).toBeUndefined();
    expect(citedSymbol("xlarge")).toBeUndefined();
  });

  it("knows a copy by name or by most lines in common, and the prose's language", () => {
    const text = Array.from({ length: 8 }, (_, i) => `- a long enough line number ${i} of the document`).join(
      "\n",
    );
    expect(
      duplicatesOf([
        { name: "a.md", text },
        { name: "b.md", text: `${text}\n- one more line of text here` },
      ]),
    ).toEqual([["a.md", "b.md"]]);
    expect(
      duplicatesOf([
        { name: "a.md", text },
        { name: "c.md", text: "- something else entirely here" },
      ]),
    ).toEqual([]);
    expect(proseLanguageOf(ENGLISH)).toBe("en");
    expect(
      proseLanguageOf("Модуль заказов хранит агрегат заказа и считает его цену до налога. ".repeat(6)),
    ).toBe("ru");
  });
});
