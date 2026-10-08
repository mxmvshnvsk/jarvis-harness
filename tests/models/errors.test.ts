import { describe, expect, it } from "vitest";
import { classifyHttpError, saysUnavailable } from "../../src/models/errors.ts";

const none = { get: () => null };

describe("a model the gateway took offline", () => {
  it("is waited for like a timeout, not failed like a bad key", () => {
    const body = JSON.stringify({ error: "Модель Flash-1 недоступна. Пожалуйста, выберите другую модель." });
    const e = classifyHttpError(403, body, none, "flash");
    expect(e.kind).toBe("transient");
    expect(e.message).toContain("the gateway says it is unavailable (403)");
    // escaped JSON as some gateways send it
    expect(
      saysUnavailable(
        '{"error":"\\u041c\\u043e\\u0434\\u0435\\u043b\\u044c \\u043d\\u0435\\u0434\\u043e\\u0441\\u0442\\u0443\\u043f\\u043d\\u0430"}',
      ),
    ).toBe(true);
    expect(
      classifyHttpError(404, '{"error":"model is not available, use a different model"}', none, "flash").kind,
    ).toBe("transient");
  });

  it("a refused key stays a configuration problem", () => {
    expect(classifyHttpError(403, '{"error":"invalid api key"}', none, "flash").kind).toBe("auth");
    expect(classifyHttpError(401, '{"error":"model unavailable"}', none, "flash").kind).toBe("auth");
  });
});
