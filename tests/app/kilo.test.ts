import { describe, expect, it } from "vitest";
import { kilo } from "../../src/app/activity.ts";

describe("token counts for people", () => {
  it("units, thousands, millions (pilot: `in 15799k`)", () => {
    expect([950, 4_200, 54_000, 999_499, 999_500, 15_799_000, 123_400_000].map(kilo)).toEqual([
      "950",
      "4.2k",
      "54k",
      "999k",
      "1.0m",
      "15.8m",
      "123m",
    ]);
  });
});
