import { describe, expect, it } from "vitest";
import { ResearchResult } from "../../src/agents/builtin/schemas.ts";
import { Journey } from "../../src/app/journey.ts";
import { docFacts } from "../../src/cli/gate.ts";
import { formatStepReport } from "../../src/cli/progress.ts";
import { documentToMarkdown } from "../../src/cli/render.ts";
import { createStyle } from "../../src/cli/style.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";

/** Pilot: the issue and its page gave «flag = true» to both branches of one rule; research copied it. */
const research = ResearchResult.parse({
  summary: "Orders: the delivery date on the order card depends on the express flag.",
  findings: [{ topic: "card", detail: "OrderCard renders the date", sources: ["src/orders/card.tsx:12"] }],
  unknowns: ["the API of the slots"],
  contradictions: [
    {
      statement: "Express orders: isExpress = true — show the slot",
      conflictsWith: "Regular orders: isExpress = true or null — show the date (the same value as express)",
      sources: ["CONF-12", "https://wiki.example.corp/pages/77770077"],
      question: "For regular orders, is it isExpress = false or null?",
    },
  ],
});

describe("contradictions in the requirements are never buried", () => {
  it("are part of the research result and come first when it is read", () => {
    expect(research.contradictions).toHaveLength(1);
    const md = documentToMarkdown(research as unknown as Record<string, unknown>);
    const at = md.indexOf("## ⚠ Contradictions");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(md.indexOf("## Findings"));
    expect(md).toContain("For regular orders, is it isExpress = false or null?");
    expect(md.match(/## ⚠ Contradictions/g)).toHaveLength(1);
    // the gate card counts them as a warning
    const facts = docFacts("research.json", JSON.stringify(research));
    expect(facts?.counts).toContainEqual({ text: "1 contradiction", warn: true });
    // a result without any parses as before
    expect(ResearchResult.parse({ summary: "x", findings: [] }).contradictions).toEqual([]);
    // asked of this repository's analyst unless the spec is another system's
    expect(research.contradictions[0]?.owner).toBe("this repository");
  });

  it("the step's line says how many there are", () => {
    let seq = 0;
    const ev = (kind: string, ts: string, payload: Record<string, unknown> = {}): StoredEvent =>
      ({ seq: ++seq, ts: `2026-10-07T10:${ts}Z`, kind, runId: "run_1", payload }) as StoredEvent;
    const j = new Journey(["research"]);
    j.push(ev("step.start", "00:00", { stepId: "research", iteration: 1, kind: "agentic" }));
    j.push(ev("agent.start", "00:01", { agent: "research" }));
    j.push(ev("agent.finish", "01:00", { status: "success", contradictions: 2 }));
    const [line] = j.push(
      ev("step.finish", "01:01", { stepId: "research", iteration: 1, status: "success" }),
    );
    if (line?.kind !== "step") throw new Error("step");
    expect(line.report.contradictions).toBe(2);
    expect(formatStepReport(line.report, [], createStyle(false), 8)[0]).toContain(
      "⚠ 2 contradictions in the requirements",
    );
  });

  it("another system's requirements are a contract this repository depends on, not its work", () => {
    const withDeps = ResearchResult.parse({
      summary: "Orders: delivery slots come from the logistics service.",
      findings: [],
      dependencies: [
        {
          system: "logistics-api",
          need: "GET /slots?date= returning [{ from, to, free }]",
          status: "missing",
          sources: ["CONF-13"],
        },
      ],
      contradictions: [
        {
          statement: "Slots: the table says only free slots are returned",
          conflictsWith: "the example response lists busy slots too",
          question: "Does GET /slots return busy slots (with free: false) or only free ones?",
          owner: "logistics-api",
        },
      ],
    });
    expect(withDeps.dependencies[0]).toMatchObject({ system: "logistics-api", status: "missing" });
    expect(
      ResearchResult.parse({ summary: "x", findings: [], dependencies: [{ system: "s", need: "n" }] })
        .dependencies[0]?.status,
    ).toBe("unknown");
    const md = documentToMarkdown(withDeps as unknown as Record<string, unknown>);
    expect(md).toContain("## Dependencies");
    expect(md).toContain("GET /slots?date=");
    expect(md).toMatch(/Owner: logistics-api/);
  });
});
