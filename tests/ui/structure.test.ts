import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type UiPages, uiPages } from "../helpers/uiPages.ts";

/**
 * What every page's markup holds, whatever is on it — the invariants the live refresh, the sticky
 * strips and the forms rest on. Pilot: a dock put between two sections stuck mid-page; the decision
 * form inside the questions came unstuck once they scrolled away.
 */
let pages: UiPages;
beforeAll(async () => {
  pages = await uiPages();
});
afterAll(async () => {
  await pages.close();
});

function parse(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

describe("the pages' structure", () => {
  for (const name of ["runs", "run", "questions", "review", "knowledge"])
    it(`${name}: live regions, ids, forms and the dock as the page's script expects them`, async () => {
      const doc = parse(await pages.get(pages.paths[name] as string));
      const problems: string[] = [];
      const live = [...doc.querySelectorAll<HTMLElement>("[data-live]")].map((e) => e.dataset.live ?? "");
      for (const n of new Set(live))
        if (live.filter((x) => x === n).length > 1) problems.push(`data-live="${n}" twice`);
      const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id);
      for (const id of new Set(ids))
        if (ids.filter((x) => x === id).length > 1) problems.push(`id="${id}" twice`);
      for (const f of doc.querySelectorAll("form form"))
        problems.push(`a form inside a form: ${f.outerHTML.slice(0, 80)}`);
      for (const el of doc.querySelectorAll("[form]")) {
        const id = el.getAttribute("form") ?? "";
        if (doc.getElementById(id)?.tagName !== "FORM") problems.push(`form="${id}" names no form`);
      }
      // a sticky strip sticks only while its place is below the screen: it is the last thing on the page
      const main = doc.querySelector("main");
      for (const dock of doc.querySelectorAll(".dock"))
        if (dock.parentElement !== main || main?.lastElementChild !== dock)
          problems.push(`a dock not last in main: ${dock.outerHTML.slice(0, 80)}`);
      expect(problems).toEqual([]);
    });

  it("the pages under test have what the checks are about", async () => {
    const runs = parse(await pages.get(pages.paths.runs as string));
    expect(runs.querySelector("main > .dock")).not.toBeNull();
    const q = parse(await pages.get(pages.paths.questions as string));
    expect(q.querySelector("main > form.dock[data-decision]")).not.toBeNull();
    expect(q.querySelectorAll('input[value^="q-opt-"]').length).toBe(6);
    const review = parse(await pages.get(pages.paths.review as string));
    expect(review.querySelector(".cols > aside.aside form[data-decision]")).not.toBeNull();
  });
});
