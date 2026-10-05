import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor } from "../../src/security/redactor.ts";
import {
  errorFields,
  eventLevel,
  Logger,
  logFiles,
  logLevelFrom,
  readLogs,
} from "../../src/telemetry/log.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let dir: string;
beforeEach(() => {
  sb = sandbox();
  dir = join(sb.root, "logs");
});
afterEach(() => sb.cleanup());

const redactor = new Redactor();
const make = (level: "off" | "error" | "info" | "debug", extra: Record<string, unknown> = {}) =>
  new Logger({ dir, level, redact: (t) => redactor.redact(t).text, ...extra });

describe("logLevelFrom", () => {
  it("reads JARVIS_LOG with info as the default", () => {
    expect(logLevelFrom({})).toBe("info");
    expect(logLevelFrom({ JARVIS_LOG: "DEBUG" })).toBe("debug");
    expect(logLevelFrom({ JARVIS_LOG: "verbose" })).toBe("debug");
    expect(logLevelFrom({ JARVIS_LOG: "off" })).toBe("off");
    expect(logLevelFrom({ JARVIS_LOG: "error" })).toBe("error");
    expect(logLevelFrom({ JARVIS_LOG: "nonsense" })).toBe("info");
  });
});

describe("Logger", () => {
  it("writes NDJSON, one file per day, and respects the level", () => {
    const log = make("info");
    log.info("a.event", { runId: "run_1", n: 1 });
    log.debug("b.event", { n: 2 });
    log.error("c.event");
    const files = logFiles(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(files[0] as string, "utf8")
      .trim()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["a.event", "c.event"]);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "info", runId: "run_1", n: 1 });

    const quiet = make("error");
    quiet.info("never");
    expect(readLogs(dir, { level: "debug" }).map((r) => r.event)).not.toContain("never");
  });

  it("level off writes nothing and creates no directory", () => {
    make("off").error("x");
    expect(existsSync(dir)).toBe(false);
  });

  it("redacts secrets inside any string and keeps every line valid JSON", () => {
    const log = make("debug");
    log.debug("model.response", {
      text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 and key sk-abcdefghijklmnopqrstuvwxyz123456",
      nested: { password: "password=hunter2hunter2" },
    });
    const raw = readFileSync(logFiles(dir)[0] as string, "utf8");
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(raw).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(raw).not.toContain("hunter2hunter2");
    expect(raw).toContain("[REDACTED");
    expect(() => JSON.parse(raw.trim())).not.toThrow();
  });

  it("cuts long strings and wide arrays, and serializes errors with their stack", () => {
    const log = make("debug", { maxField: 200 });
    log.debug("big", { text: "x".repeat(1000), list: Array.from({ length: 600 }, (_, i) => i) });
    log.error("boom", errorFields(new Error("kaput")));
    const [big, boom] = readLogs(dir, { level: "debug" });
    expect(String(big?.text).length).toBeLessThan(260);
    expect(String(big?.text)).toContain("cut 800 chars");
    expect(big?.list as unknown[]).toHaveLength(501);
    expect(boom).toMatchObject({ name: "Error", message: "kaput" });
    expect(String(boom?.stack)).toContain("kaput");
  });

  it("writes the whole cause chain of an error, down to the code that names the problem", () => {
    const log = make("debug");
    const tls = Object.assign(new Error("self-signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    log.error("tls", errorFields(new TypeError("fetch failed", { cause: tls })));
    log.error(
      "refused",
      errorFields(new TypeError("fetch failed", { cause: new AggregateError([refused]) })),
    );
    const [first, second] = readLogs(dir, { level: "debug" });
    expect(first?.cause).toBe("SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain");
    // the code is already in the message: not repeated
    expect(second?.cause).toBe("connect ECONNREFUSED 127.0.0.1:1");
  });

  it("logs a prompt as a delta and notes when context management rewrote it", () => {
    const log = make("debug");
    const a = { role: "system", content: "s" };
    const b = { role: "user", content: "u" };
    const c = { role: "assistant", content: "a" };
    expect(log.promptDelta("s1", [a, b])).toMatchObject({ from: 0, total: 2, rewritten: 0 });
    const second = log.promptDelta("s1", [a, b, c]);
    expect(second).toMatchObject({ from: 2, total: 3, rewritten: 0 });
    expect(second.messages).toEqual([c]);
    // history was compacted: the second message is different now
    const third = log.promptDelta("s1", [a, { role: "user", content: "summary" }, c]);
    expect(third).toMatchObject({ from: 1, total: 3, rewritten: 2 });
    // another stream starts fresh
    expect(log.promptDelta("s2", [a])).toMatchObject({ from: 0 });
  });

  it("removes files older than the retention on first write", () => {
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "jarvis-2020-01-01.ndjson");
    writeFileSync(old, "{}\n");
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, longAgo, longAgo);
    writeFileSync(join(dir, "notes.txt"), "keep");
    make("info", { keepDays: 14 }).info("x");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("never throws, even when the directory cannot be created", () => {
    const blocked = join(sb.root, "file");
    writeFileSync(blocked, "not a dir");
    const log = new Logger({ dir: join(blocked, "logs"), level: "info" });
    expect(() => log.info("x")).not.toThrow();
  });
});

describe("readLogs / eventLevel", () => {
  it("filters by run prefix, level, event and age, and keeps the tail", () => {
    const log = make("debug");
    log.info("model.call", { runId: "run_aaaa1" });
    log.error("model.error", { runId: "run_aaaa1" });
    log.debug("model.request", { runId: "run_aaaa1" });
    log.info("model.call", { runId: "run_bbbb2" });
    expect(readLogs(dir, { run: "run_aaaa" }).map((r) => r.event)).toEqual(["model.call", "model.error"]);
    expect(readLogs(dir, { level: "error" }).map((r) => r.event)).toEqual(["model.error"]);
    expect(readLogs(dir, { level: "debug", run: "run_aaaa" })).toHaveLength(3);
    expect(readLogs(dir, { event: "request", level: "debug" })).toHaveLength(1);
    expect(readLogs(dir, { tail: 1 }).map((r) => r.runId)).toEqual(["run_bbbb2"]);
    expect(readLogs(dir, { sinceMs: 1000 })).toHaveLength(3);
    expect(readLogs(dir, { sinceMs: 1000 }, Date.now() + 3_600_000)).toHaveLength(0);
  });

  it("classifies failure events as errors", () => {
    expect(eventLevel("model.error")).toBe("error");
    expect(eventLevel("tool.denied")).toBe("error");
    expect(eventLevel("context.compaction_failed")).toBe("error");
    expect(eventLevel("graph.update_failed")).toBe("error");
    expect(eventLevel("step.error")).toBe("error");
    expect(eventLevel("model.call")).toBe("info");
    expect(eventLevel("tool.call")).toBe("info");
  });
});
