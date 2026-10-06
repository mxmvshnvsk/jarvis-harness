import { describe, expect, it } from "vitest";
import { compilePatterns, PathPolicy, Redactor, secretLiteralsFromEnv } from "../../src/security/redactor.ts";

/** ADR-0010 §5: a corpus of synthetic secrets; every sink must drop all of them. */
const SECRET_CORPUS: Array<{ type: string; value: string; context: string }> = [
  {
    type: "literal",
    value: "corp-llm-token-9f8e7d6c5b4a",
    context: "Authorization header was corp-llm-token-9f8e7d6c5b4a in the log",
  },
  {
    type: "aws-access-key",
    value: "AKIAIOSFODNN7EXAMPLE",
    context: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
  },
  {
    type: "github-token",
    value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    context: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  },
  { type: "slack-token", value: "xoxb-1234567890-abcdefghij", context: "slack: xoxb-1234567890-abcdefghij" },
  {
    type: "openai-key",
    value: "sk-proj-abcdefghijklmnopqrstuvwxyz1234",
    context: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234",
  },
  {
    type: "jwt",
    value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    context:
      "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  },
  {
    type: "bearer",
    value: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA",
    context: "curl -H 'Authorization: Bearer Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA'",
  },
  {
    type: "basic-auth-url",
    value: "s3cretPassw0rd",
    context: "git clone https://deploy:s3cretPassw0rd@git.corp.local/repo.git",
  },
  {
    type: "pem",
    value: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
    context:
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----",
  },
  { type: "assignment", value: "hunter2hunter2", context: 'password = "hunter2hunter2"' },
  {
    type: "high-entropy",
    value: "X9fK2mP8qL4vN7bR1tY6wE3zA5cH0jD",
    context: "api_key: X9fK2mP8qL4vN7bR1tY6wE3zA5cH0jD",
  },
];

describe("Redactor", () => {
  const redactor = new Redactor({ literals: ["corp-llm-token-9f8e7d6c5b4a"], salt: "test" });

  it("keeps repository paths in tool arguments, but not a token cut by slashes (pilot)", () => {
    for (const text of [
      '{"path":"packages/shared/eslint-config/base.js"}',
      "file: packages/shared-lib/src/billing/invoice-rules/billingSettings.ts",
      "knowledge: documentation/billing/CURRENCY_CODES.md",
    ]) {
      expect(redactor.redact(text)).toMatchObject({ text, count: 0 });
    }
    const secret = "token: Ab3kX9fK2mP8q/L4vN7bR1tY6wE3zA5cH0jD";
    expect(redactor.redact(secret).text).not.toContain("L4vN7bR1tY6wE3zA5cH0jD");
  });

  it("removes every corpus secret and keeps the surrounding text", () => {
    for (const item of SECRET_CORPUS) {
      const r = redactor.redact(item.context);
      expect(r.text, item.type).not.toContain(item.value);
      expect(r.count, item.type).toBeGreaterThan(0);
      expect(r.text).toMatch(/\[REDACTED:[a-z-]+:[0-9a-f]{8}\]/);
    }
  });

  it("keeps prefixes so the structure stays readable", () => {
    expect(redactor.redact("Authorization: Bearer Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA").text).toMatch(
      /^Authorization: Bearer \[REDACTED:bearer:/,
    );
    expect(redactor.redact("https://deploy:s3cretPassw0rd@git.corp.local/x").text).toBe(
      `https://deploy:${redactor.placeholder("basic-auth-url", "s3cretPassw0rd")}@git.corp.local/x`,
    );
    expect(redactor.redact('token = "abcdefgh12345678"').text).toMatch(/^token = "\[REDACTED:assignment:/);
  });

  it("is deterministic within a run and different across runs", () => {
    const a = redactor.redact("key corp-llm-token-9f8e7d6c5b4a and again corp-llm-token-9f8e7d6c5b4a").text;
    const [p1, p2] = a.match(/\[REDACTED[^\]]+\]/g) ?? [];
    expect(p1).toBe(p2);
    const other = new Redactor({ literals: ["corp-llm-token-9f8e7d6c5b4a"], salt: "other" });
    expect(other.redact("corp-llm-token-9f8e7d6c5b4a").text).not.toBe(
      redactor.redact("corp-llm-token-9f8e7d6c5b4a").text,
    );
  });

  it("does not touch identifiers provenance depends on", () => {
    const sha = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const text = `commit ${sha}\nblob sha256=${"a".repeat(64)}\nrun id = ${uuid}\nPR #481 by user ABC-123`;
    const r = redactor.redact(text);
    expect(r.text).toBe(text);
    expect(r.count).toBe(0);
  });

  it("keeps long names from code, still masks secret-looking values (pilot)", () => {
    const code = [
      "15:    isCompactModeEnabledForCustomerSelector,",
      "            attachDeliveryAddressPage: attachDeliveryAddressPageCompactAC,",
      "    const addressSelector = isEditMode ? foreignAddressesByType : compactForeignAddressesByType;",
      "type: SAVE_ORDER_SUCCESS_V2",
    ].join("\n");
    expect(redactor.redact(code)).toMatchObject({ text: code, count: 0 });
    for (const secret of [
      "Ab3kX9fK2mP8qL4vN7bR1tY6wE3zA5cH0jD",
      "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MAbcdef",
      "qWeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIo",
    ])
      expect(redactor.redact(`key: ${secret}`).count, secret).toBe(1);
  });

  it("redacts strings inside JSON-like values", () => {
    const r = redactor.redactValue({
      args: { header: "Bearer Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA" },
      list: ["AKIAIOSFODNN7EXAMPLE", 1, null],
    });
    expect(JSON.stringify(r.value)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.count).toBe(2);
  });

  it("collects literals from the environment by name and supports custom patterns", () => {
    const literals = secretLiteralsFromEnv(
      { CORP_TOKEN: "tok-123456789", HOME: "/home/x", LOG_LEVEL: "debug", MY_SPECIAL: "spec-99999999" },
      ["MY_SPECIAL"],
    );
    expect(literals).toEqual(["tok-123456789", "spec-99999999"]);
    const custom = new Redactor({
      patterns: compilePatterns([{ name: "corp-id", regex: "CORP-[0-9]{6}" }]),
      salt: "s",
    });
    expect(custom.redact("ticket CORP-123456 ok").text).toMatch(/ticket \[REDACTED:corp-id:[0-9a-f]{8}\] ok/);
  });
});

describe("PathPolicy", () => {
  const policy = new PathPolicy();
  it("denies secret locations and allows ordinary code", () => {
    for (const p of [
      ".env",
      ".env.local",
      "apps/api/.env",
      "config/secrets/db.yaml",
      "certs/server.pem",
      "keys/deploy.key",
      ".ssh/id_rsa",
      ".aws/credentials",
      ".npmrc",
    ]) {
      expect(policy.isDenied(p), p).toBe(true);
    }
    for (const p of ["src/index.ts", "README.md", "env.example", "docs/environment.md", "src/keys.ts"]) {
      expect(policy.isDenied(p), p).toBe(false);
    }
  });
});
