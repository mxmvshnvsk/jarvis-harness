import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RU, RU_PLURALS } from "../../src/ui/i18n/ru.ts";
import { inLang, plural, ruForm, t } from "../../src/ui/i18n.ts";

const UI = join(import.meta.dirname, "../../src/ui");
/** Every `t("…")` written in the page's code: the keys the dictionary must have. */
function keysInCode(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const name of readdirSync(UI).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(UI, name), "utf8");
    for (const m of text.matchAll(/\bth?\("((?:[^"\\]|\\.)*)"/g)) keys.set(JSON.parse(`"${m[1]}"`), name);
  }
  return keys;
}
/** Every noun given to `plural(n, "…")`: the forms RU_PLURALS must have. */
function nounsInCode(): Map<string, string> {
  const nouns = new Map<string, string>();
  for (const name of readdirSync(UI).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(UI, name), "utf8");
    for (const m of text.matchAll(/\bplural\([^,()]+(?:\([^()]*\))?[^,()]*, "([^"]+)"/g))
      nouns.set(m[1] as string, name);
  }
  return nouns;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("the page in Russian", () => {
  it("every string of the code has its translation, with the same placeholders", () => {
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const [key, file] of keysInCode()) {
      const ru = RU[key];
      if (ru === undefined) missing.push(`${file}: ${key}`);
      else if (placeholders(ru).join() !== placeholders(key).join()) wrong.push(`${key} → ${ru}`);
    }
    expect(missing).toEqual([]);
    expect(wrong).toEqual([]);
  });

  it("every noun counted on a page has its Russian forms", () => {
    const missing = [...nounsInCode()]
      .filter(([noun]) => !RU_PLURALS[noun])
      .map(([noun, file]) => `${file}: ${noun}`);
    expect(missing).toEqual([]);
  });

  it("no translation is left over from a string the code no longer has", () => {
    const used = new Set(keysInCode().keys());
    const states = new Set<string>();
    expect(Object.keys(RU).filter((k) => !used.has(k) && !states.has(k))).toEqual([]);
  });

  it("the Russian forms of a number: 1 прогон, 2 прогона, 5 прогонов, 11 прогонов, 21 прогон", () => {
    const forms = RU_PLURALS.run as readonly [string, string, string];
    expect([1, 2, 5, 11, 12, 21, 22, 25, 101].map((n) => ruForm(n, forms))).toEqual([
      "прогон",
      "прогона",
      "прогонов",
      "прогонов",
      "прогонов",
      "прогон",
      "прогона",
      "прогонов",
      "прогон",
    ]);
    expect(inLang("ru", () => plural(2, "round left", "rounds left"))).toBe("осталось 2 круга");
    expect(inLang("ru", () => plural(1, "round left", "rounds left"))).toBe("остался 1 круг");
    expect(inLang("en", () => plural(2, "model call"))).toBe("2 model calls");
  });

  it("English by default, the placeholders filled in either language", () => {
    expect(t("Round {n} of {m}", { n: 2, m: 3 })).toBe("Round 2 of 3");
    expect(inLang("ru", () => t("Round {n} of {m}", { n: 2, m: 3 }))).toBe("Круг 2 из 3");
    // what has no translation stays as it is
    expect(inLang("ru", () => t("orders-api"))).toBe("orders-api");
  });
});
