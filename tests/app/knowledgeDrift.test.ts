import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { candidatesOf, promoteCandidate } from "../../src/app/candidates.ts";
import {
  checkDrift,
  claimIn,
  driftIn,
  openDrift,
  proposeDriftCandidates,
  withDriftNotes,
} from "../../src/app/knowledgeDrift.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { remapNote } from "../../src/cli/commands/onboard.ts";
import { ACTOR, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;

const DOC = `---
paths: [src/billing/**]
---
# Billing

## Flow

Payments are retried three times by the RetryQueue before the order fails.

## Storage

Invoices live in the invoices table.
`;

beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  sb.write("project/.jarvis/knowledge/module-billing.md", DOC);
  sb.write("project/src/billing/retry.ts", "export const ATTEMPTS = 5;\nexport class RetryQueue {}\n");
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const docFile = () => join(sb.project, ".jarvis", "knowledge", "module-billing.md");
const newRun = (task = "ABC-42") =>
  rt.runs.create({
    task,
    workflow: "drift",
    owner: ACTOR,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: rt.loaded.config.dataClass,
  });
const research = (runId: string, knowledgeDrift: unknown) =>
  rt.artifacts.put({
    runId,
    type: "research",
    name: "research.json",
    content: JSON.stringify({ summary: "s", findings: [], knowledgeDrift }),
    mediaType: "application/json",
    provenance: { kind: "agent", agentId: "research" },
    stepId: "research",
  });

const RETRY = {
  doc: "module-billing.md",
  section: "Flow",
  claim: "Payments are retried three times by the RetryQueue",
  actual: "five attempts (ATTEMPTS = 5)",
  sources: ["src/billing/retry.ts:1"],
};

describe("knowledge drift found by runs", () => {
  it("reads the findings of an artifact", () => {
    expect(driftIn("nope")).toEqual([]);
    expect(driftIn(JSON.stringify({ knowledgeDrift: [RETRY, { doc: "x.md", claim: "c" }] }))).toEqual([
      RETRY,
    ]);
  });

  it("the document must say it, a cited line must be in the code", () => {
    expect(claimIn(DOC, "payments are RETRIED three times by the `RetryQueue`", "Flow")).toBe(true);
    // most words of the claim, quoted loosely
    expect(claimIn(DOC, "the RetryQueue retries payments three times", "Flow")).toBe(true);
    // not in that section
    expect(claimIn(DOC, "Payments are retried three times", "Storage")).toBe(false);
    expect(claimIn(DOC, "Refunds go to a ledger service")).toBe(false);

    expect(checkDrift(sb.project, RETRY)).toMatchObject({
      ok: true,
      path: ".jarvis/knowledge/module-billing.md",
    });
    expect(checkDrift(sb.project, { ...RETRY, doc: "module-none.md" })).toMatchObject({ ok: false });
    expect(checkDrift(sb.project, { ...RETRY, claim: "Refunds go to a ledger service" })).toMatchObject({
      ok: false,
    });
    expect(
      checkDrift(sb.project, { ...RETRY, sources: ["src/billing/retry.ts:40", "src/gone.ts:1"] }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("a finding goes under the section it corrects, the rest at the end", () => {
    const text = withDriftNotes(
      DOC,
      [RETRY, { ...RETRY, section: "Nowhere", claim: "x", actual: "y" }],
      "r1",
    );
    const lines = text.split("\n");
    const note = lines.findIndex((l) => l.startsWith("> ⚠ five attempts"));
    expect(note).toBeGreaterThan(lines.indexOf("## Flow"));
    expect(note).toBeLessThan(lines.indexOf("## Storage"));
    expect(lines[note]).toContain("`src/billing/retry.ts:1`");
    expect(text.trimEnd().split("\n").at(-1)).toMatch(/^> ⚠ y/);
  });

  it("a completed run's checked findings become one candidate per document, once", async () => {
    const run = newRun();
    research(run.id, [RETRY, { ...RETRY, claim: "Refunds go to a ledger service" }]);
    const made = proposeDriftCandidates(rt, run);
    expect(made).toHaveLength(1);
    expect(
      rt.events.list({ runId: run.id }).find((e) => e.kind === "knowledge.drift")?.payload,
    ).toMatchObject({
      proposed: 1,
      dropped: [expect.stringContaining("does not say")],
    });
    // proposed before: not again
    const again = newRun("ABC-43");
    research(again.id, [RETRY]);
    expect(proposeDriftCandidates(rt, again)).toEqual([]);

    // open: the next run's agents see it with the document, onboard --stale tells the mapper
    expect([...openDrift(rt).keys()]).toEqual([".jarvis/knowledge/module-billing.md"]);
    const note = remapNote({
      doc: ".jarvis/knowledge/module-billing.md",
      text: DOC,
      reasons: ["1 place(s) where runs found it disagrees with the code"],
      changed: [],
      lost: [],
      drift: openDrift(rt).get(".jarvis/knowledge/module-billing.md") ?? [],
    });
    expect(note).toContain("Runs found it wrong: Flow: the document says «Payments are retried");

    // accepting writes it into the document
    const c = candidatesOf(rt).find((x) => x.doc.kind === "knowledge-fix");
    expect(c?.doc.drift?.items).toHaveLength(1);
    promoteCandidate(rt, {
      root: sb.project,
      candidate: c as NonNullable<typeof c>,
      actor: ACTOR,
      channel: "cli",
    });
    expect(readFileSync(docFile(), "utf8")).toContain("> ⚠ five attempts (ATTEMPTS = 5)");
    expect(openDrift(rt).size).toBe(0);
  });

  it("the module mapped again settles what runs found on its old document", () => {
    const run = newRun();
    research(run.id, [RETRY]);
    proposeDriftCandidates(rt, run);
    const map = rt.artifacts.put({
      runId: run.id,
      type: "candidate",
      name: "module.json",
      content: JSON.stringify({
        kind: "knowledge",
        title: "module src/billing",
        module: "src/billing",
        rationale: "r",
        proposal: "# Billing\n\nFive attempts.\n",
      }),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "onboard" },
      stepId: "map",
    });
    const c = candidatesOf(rt).find((x) => x.artifact.artifactId === map.artifactId);
    promoteCandidate(rt, {
      root: sb.project,
      candidate: c as NonNullable<typeof c>,
      actor: ACTOR,
      id: "module-billing",
      replace: true,
      channel: "cli",
    });
    expect(openDrift(rt).size).toBe(0);
    expect(
      candidatesOf(rt)
        .filter((x) => x.doc.kind === "knowledge-fix")
        .map((x) => x.decision),
    ).toEqual(["approve"]);
  });
});
