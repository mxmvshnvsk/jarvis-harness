import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idleTimeout } from "../../src/models/providers/openaiCompatible.ts";

describe("idleTimeout: the model's timeout counts silence, not the whole answer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a stream that keeps sending is not cut, however long it goes", () => {
    const t = idleTimeout(1_000);
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(900);
      t.touch();
    }
    expect(t.signal.aborted).toBe(false);
    t.stop();
  });

  it("silence past the timeout aborts as a timeout", () => {
    const t = idleTimeout(1_000);
    vi.advanceTimersByTime(1_001);
    expect(t.signal.aborted).toBe(true);
    expect((t.signal.reason as Error).name).toBe("TimeoutError");
  });
});
