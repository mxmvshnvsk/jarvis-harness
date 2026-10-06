import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { dispatcherFor, FETCH_DEFAULT_TIMEOUT_MS } from "../../src/models/http.ts";
import { OpenAiCompatibleAdapter } from "../../src/models/providers/openaiCompatible.ts";

describe("long model requests", () => {
  it("get a dispatcher past undici's 300 s header timeout only when the model allows longer (pilot)", async () => {
    expect(await dispatcherFor(FETCH_DEFAULT_TIMEOUT_MS)).toBeUndefined();
    const long = await dispatcherFor(900_000);
    expect(long?.constructor.name).toBe("Agent");
    expect(await dispatcherFor(900_000)).toBe(long);
  });

  it("the adapter passes it to fetch and the request still works", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    let seen: unknown;
    const adapter = new OpenAiCompatibleAdapter((url, init) => {
      seen = (init as { dispatcher?: unknown }).dispatcher;
      return fetch(url, init);
    });
    const model = {
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "m",
      timeoutMs: 600_000,
      maxOutput: 100,
    } as never;
    const r = await adapter.call(
      { modelId: "m", messages: [{ role: "user", content: "hi" }] } as never,
      model,
      { headers: {} } as never,
    );
    server.close();
    expect(r.text).toBe("ok");
    expect(seen).toBe(await dispatcherFor(600_000));
  });
});
