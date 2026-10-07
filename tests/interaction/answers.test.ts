import { describe, expect, it } from "vitest";
import {
  answersText,
  checkSuggestions,
  givenFromForm,
  openQuestionsOf,
} from "../../src/interaction/answers.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Answers to a document's open questions before its gate: what the model proposes is checked in code. */
const QUESTIONS = [
  "What does the slots API return for a closed zone?",
  "What if it is down?",
  "Which wording?",
];
const MATERIAL = [
  "## sources/sources.md",
  "Confluence 4400123 · GET /delivery-slots: 200 with an empty list for a closed zone",
  "Figma node 1001:2002",
  "ABC-42",
].join("\n");

describe("suggested answers", () => {
  it("reads the open questions of a JSON document", () => {
    expect(openQuestionsOf(JSON.stringify({ openQuestions: ["a", " ", 3, "b"] }))).toEqual(["a", "b"]);
    expect(openQuestionsOf("# not JSON")).toEqual([]);
  });

  it("keeps the sources the run has; an answer with none is a guess, a decision needs two options", () => {
    let sb: Sandbox | undefined;
    try {
      sb = sandbox();
      sb.write("project/src/orders/slots.ts", "export const slots = [];\n");
      const items = checkSuggestions(
        QUESTIONS,
        [
          {
            question: 1,
            about: ["R2"],
            kind: "answer",
            answer: "An empty list with 200",
            options: [],
            sources: [
              "Confluence 4400123 · Responses",
              "Confluence 7700001 · made up",
              "src/orders/slots.ts:1",
            ],
          },
          {
            question: 2,
            about: [],
            kind: "decision",
            options: [
              { text: "The local schedule", note: "today's behaviour", suggested: true },
              { text: "An error", note: "", suggested: true },
            ],
            sources: [],
          },
          {
            question: 3,
            about: [],
            kind: "answer",
            answer: "«Delivery terms apply»",
            options: [],
            sources: ["the page"],
          },
        ],
        MATERIAL,
        sb.project,
      );
      expect(items[0]).toMatchObject({
        kind: "answer",
        sources: ["Confluence 4400123 · Responses", "src/orders/slots.ts:1"],
      });
      // one suggestion at most
      expect(items[1]?.options.map((o) => o.suggested)).toEqual([true, false]);
      // no checkable source: shown as a guess, not picked
      expect(items[2]).toMatchObject({ kind: "unknown", unbacked: true, answer: "«Delivery terms apply»" });
      // a question the model skipped is asked plainly
      expect(checkSuggestions(["x"], [], MATERIAL, sb.project)[0]).toMatchObject({ kind: "unknown" });
      expect(
        checkSuggestions(
          ["x"],
          [
            {
              question: 1,
              about: [],
              kind: "decision",
              options: [{ text: "only one", note: "", suggested: true }],
              sources: [],
            },
          ],
          MATERIAL,
          sb.project,
        )[0]?.kind,
      ).toBe("unknown");
    } finally {
      sb?.cleanup();
    }
  });

  it("reads the form against the document: Jarvis's answer, an option, one's own words, the analyst", () => {
    const suggestions = {
      for: "art_1@1",
      items: checkSuggestions(
        QUESTIONS,
        [
          {
            question: 1,
            about: [],
            kind: "answer",
            answer: "An empty list",
            options: [],
            sources: ["ABC-42"],
          },
          {
            question: 2,
            about: [],
            kind: "decision",
            options: [
              { text: "The local schedule", note: "", suggested: true },
              { text: "An error", note: "", suggested: false },
            ],
            sources: [],
          },
        ],
        MATERIAL,
        "/nowhere",
      ),
    };
    const form: Record<string, string> = {
      "qa-1": "jarvis",
      "qa-2": "opt-1",
      "qa-3": "own",
      "qa-text-3": "  ",
    };
    expect(givenFromForm(QUESTIONS, suggestions, (k) => form[k] ?? null)).toEqual([
      { question: QUESTIONS[0], mode: "answer", text: "An empty list" },
      { question: QUESTIONS[1], mode: "answer", text: "An error" },
    ]);
    form["qa-text-3"] = "Ask legal";
    form["qa-1"] = "scope";
    const given = givenFromForm(QUESTIONS, suggestions, (k) => form[k] ?? null);
    expect(given.map((g) => g.mode)).toEqual(["scope", "answer", "answer"]);
    expect(answersText(given)).toContain("→ out of the task's scope: drop it.");
  });
});
