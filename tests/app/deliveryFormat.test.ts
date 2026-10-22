import { describe, expect, it } from "vitest";
import { branchOf, commitMessageOf, FormatError, headerOf, scopeOf } from "../../src/app/deliveryFormat.ts";
import { DeliveryConfigSchema } from "../../src/core/config/schema.ts";

/** The team's formats for a run's branch, commit and PR title (`delivery`). */

const cfg = (over: Record<string, unknown> = {}) => DeliveryConfigSchema.parse(over);
const input = {
  task: "ABC-42 discount by promo code",
  title: "ABC-42: Discount by promo code in the order.",
  kind: "feature",
  files: ["orders/src/Promo.java", "orders/src/Order.java", "README.md"],
  runId: "run_1a2b3c4d5e6f",
};

describe("delivery formats", () => {
  it("by default: the title as it is, with Jarvis's trailers", () => {
    const message = commitMessageOf(cfg(), input);
    expect(message).toMatch(
      /^ABC-42: Discount by promo code in the order\n\nJarvis-Run: run_1a2b3c4d5e6f\nAssisted-By: Jarvis \S+$/,
    );
    expect(branchOf(cfg(), input)).toBeUndefined();
  });

  it("Conventional Commits with the key: type from the kind, scope from the change", () => {
    const c = cfg({ commit: { format: "{type}({scope}): {key} {subject}" } });
    expect(headerOf(c, input, c.commit.format)).toBe(
      "feat(orders): ABC-42 Discount by promo code in the order",
    );
    // the key as the scope; no scope — no parentheses
    expect(headerOf(c, { ...input, kind: "fix" }, "{type}({key}): {subject}")).toBe(
      "fix(ABC-42): Discount by promo code in the order",
    );
    const none = cfg({ commit: { format: "{type}({scope}): {key} {subject}", scope: "none" } });
    expect(headerOf(none, input, none.commit.format)).toBe(
      "feat: ABC-42 Discount by promo code in the order",
    );
    // the context the implementation named, in a word: not the repository's name
    expect(headerOf(c, { ...input, scope: "Metrics" }, c.commit.format)).toMatch(/^feat\(metrics\):/);
    expect(headerOf(c, { ...input, scope: "orders api client" }, c.commit.format)).toMatch(
      /^feat\(orders\):/,
    );
  });

  it("a long subject is cut at a word: the header stays within 72", () => {
    const c = cfg({ commit: { format: "{type}({scope}): {key} {subject}" } });
    const long = {
      ...input,
      title: "Discount by promo code in the order with limits per customer and per campaign period",
    };
    const header = headerOf(c, long, c.commit.format);
    expect(header.length).toBeLessThanOrEqual(72);
    expect(header).toMatch(/^feat\(orders\): ABC-42 Discount by promo code .*\w$/);
  });

  it("the branch by the team's rule; a format that wants the key refuses a task without one", () => {
    expect(branchOf(cfg({ branch: "feature/{key}" }), input)).toBe("feature/ABC-42");
    expect(branchOf(cfg({ branch: "feature/{key}_{slug}" }), input)).toBe(
      "feature/ABC-42_discount_by_promo_code_in_the_order",
    );
    expect(
      branchOf(cfg({ branch: "feature/{key}-{slug}" }), { ...input, title: "Скидка по промокоду" }),
    ).toBe("feature/ABC-42-skidka-po-promokodu");
    expect(() => branchOf(cfg({ branch: "feature/{key}" }), { ...input, task: "discount" })).toThrow(
      FormatError,
    );
  });

  it("no Assisted-By when it is off", () => {
    expect(commitMessageOf(cfg({ assistedBy: false }), input)).not.toContain("Assisted-By");
  });

  it("scope by the files when the agent named none: tests, docs, the folder most of it is in, none when spread", () => {
    expect(scopeOf(["src/test/java/shop/OrderServiceTest.java", "src/app/form.spec.ts"])).toBe("tests");
    expect(scopeOf(["docs/a.md", "README.md"])).toBe("docs");
    expect(
      scopeOf([
        "src/main/java/com/example/shop/render/Page.java",
        "src/main/java/com/example/shop/render/Block.java",
        "src/test/java/com/example/shop/render/PageTest.java",
      ]),
    ).toBe("render");
    expect(scopeOf(["src/metrics/a.ts", "src/auth/b.ts"])).toBe("");
  });
});
