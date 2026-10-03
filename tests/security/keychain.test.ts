import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keychain, KeychainSecretResolver, selectBackend } from "../../src/security/credentials/keychain.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("keychain backends (ADR-0017 §5)", () => {
  it("selects by platform and available tools, with the file backend as the fallback", () => {
    const file = join(sb.home, "credentials.json");
    expect(
      selectBackend({ actorId: "a", file, platform: "darwin", hasCommand: (n) => n === "security" }).kind,
    ).toBe("macos");
    expect(selectBackend({ actorId: "a", file, platform: "darwin", hasCommand: () => false }).kind).toBe(
      "file",
    );
    expect(
      selectBackend({ actorId: "a", file, platform: "linux", hasCommand: (n) => n === "secret-tool" }).kind,
    ).toBe("libsecret");
    expect(selectBackend({ actorId: "a", file, platform: "linux", hasCommand: () => false }).kind).toBe(
      "file",
    );
    expect(selectBackend({ actorId: "a", file, platform: "win32", hasCommand: () => false }).kind).toBe(
      "windows",
    );
    expect(selectBackend({ actorId: "a", file, platform: "linux", backend: "file" }).kind).toBe("file");
    expect(selectBackend({ actorId: "a", file, platform: "linux", backend: "windows" }).kind).toBe("windows");
  });

  it("namespaces entries by actor and caches resolved values for the redactor", async () => {
    const file = join(sb.home, "credentials.json");
    const a = new Keychain({ actorId: "me@corp", file, backend: "file" });
    const b = new Keychain({ actorId: "other@corp", file, backend: "file" });
    await a.set("jira", "token-of-me-123456");
    expect(await a.get("jira")).toBe("token-of-me-123456");
    expect(await b.get("jira")).toBeUndefined();
    const seen: string[] = [];
    const resolver = new KeychainSecretResolver(a, (v) => seen.push(v));
    expect(resolver.supports("keychain:jira")).toBe(true);
    expect(resolver.supports("env:X")).toBe(false);
    expect(await resolver.resolve("keychain:jira")).toBe("token-of-me-123456");
    expect(await resolver.resolve("keychain:jira")).toBe("token-of-me-123456");
    expect(seen).toEqual(["token-of-me-123456"]);
    expect(await a.remove("jira")).toBe(true);
    expect(await a.remove("jira")).toBe(false);
  });
});
