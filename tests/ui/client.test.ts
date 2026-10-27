// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { edited, followsJournal, inPhase, morphRegions, startClocks } from "../../src/ui/client/live.ts";

/**
 * The page's live refresh on a DOM: each `[data-live]` region morphed to the server's fresh rendering,
 * so what a person does on the page stays — the pilot's bugs of the replaced regions, one by one.
 */
const page = (body: string, title = "Runs") =>
  new DOMParser().parseFromString(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    "text/html",
  );

beforeEach(() => {
  document.head.innerHTML = "<title>Runs</title>";
  document.body.innerHTML = "";
});

describe("the live refresh", () => {
  it("changes what changed, and keeps the elements that stay", () => {
    document.body.innerHTML = `<section data-live="now"><h2>research</h2><span class="spin"></span><p id="m">model call 3</p></section>`;
    inPhase(document);
    const spin = document.querySelector<HTMLElement>(".spin");
    const delay = spin?.style.animationDelay;
    morphRegions(
      document,
      page(
        `<section data-live="now"><h2>research</h2><span class="spin"></span><p id="m">model call 4</p></section>`,
        "Run 1",
      ),
    );
    expect(document.querySelector("#m")?.textContent).toBe("model call 4");
    // the same spinner, its phase kept: it does not start again at 0° on every event
    expect(document.querySelector(".spin")).toBe(spin);
    expect(document.querySelector<HTMLElement>(".spin")?.style.animationDelay).toBe(delay);
    expect(document.title).toBe("Run 1");
  });

  it("a new spinner takes the page clock's phase", () => {
    document.body.innerHTML = `<section data-live="now"><p>idle</p></section>`;
    morphRegions(document, page(`<section data-live="now"><span class="spin"></span></section>`));
    expect(document.querySelector<HTMLElement>(".spin")?.style.animationDelay).toMatch(/^-?\d+(\.\d+)?ms$/);
  });

  it("a fold a person opened stays open, one they closed stays closed", () => {
    document.body.innerHTML = `<div data-live="feed"><details id="a"><summary>a</summary>x</details><details id="b" open><summary>b</summary>y</details></div>`;
    (document.querySelector("#a") as HTMLDetailsElement).open = true;
    (document.querySelector("#b") as HTMLDetailsElement).open = false;
    morphRegions(
      document,
      page(
        `<div data-live="feed"><details id="a"><summary>a</summary>x2</details><details id="b" open><summary>b</summary>y2</details></div>`,
      ),
    );
    expect((document.querySelector("#a") as HTMLDetailsElement).open).toBe(true);
    expect((document.querySelector("#b") as HTMLDetailsElement).open).toBe(false);
    expect(document.querySelector("#a")?.textContent).toContain("x2");
  });

  it("a region with unsent changes waits for them: a typed comment, a ticked box, a picked answer", () => {
    document.body.innerHTML = `<form data-live="qs"><textarea name="c"></textarea><input type="radio" name="q" value="a"><p>v1</p></form><div data-live="other"><p>v1</p></div>`;
    (document.querySelector("textarea") as HTMLTextAreaElement).value = "half a thought";
    expect(edited(document.querySelector("[data-live=qs]") as Element)).toBe(true);
    morphRegions(
      document,
      page(
        `<form data-live="qs"><textarea name="c"></textarea><input type="radio" name="q" value="a"><p>v2</p></form><div data-live="other"><p>v2</p></div>`,
      ),
    );
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("half a thought");
    expect(document.querySelector("[data-live=qs] p")?.textContent).toBe("v1");
    expect(document.querySelector("[data-live=other] p")?.textContent).toBe("v2");
    (document.querySelector("textarea") as HTMLTextAreaElement).value = "";
    (document.querySelector("input") as HTMLInputElement).checked = true;
    expect(edited(document.querySelector("[data-live=qs]") as Element)).toBe(true);
  });

  it("the element in focus keeps it", () => {
    document.body.innerHTML = `<div data-live="card"><button id="go">Accept</button><p>3 calls</p></div>`;
    const button = document.querySelector<HTMLButtonElement>("#go");
    button?.focus();
    morphRegions(document, page(`<div data-live="card"><button id="go">Accept</button><p>4 calls</p></div>`));
    expect(document.activeElement).toBe(button);
    expect(document.querySelector("[data-live=card] p")?.textContent).toBe("4 calls");
  });

  it("a region gone from the fresh page keeps an empty slot (a finished run has no «now» card)", () => {
    document.body.innerHTML = `<div data-live="card"><span class="spin"></span></div>`;
    morphRegions(document, page(`<p>done</p>`));
    const slot = document.querySelector<HTMLElement>("[data-live=card]");
    expect(slot?.hidden).toBe(true);
    expect(slot?.querySelector(".spin")).toBeNull();
    // and comes back when the page has it again
    morphRegions(document, page(`<div data-live="card"><p>again</p></div>`));
    expect(document.querySelector("[data-live=card]")?.textContent).toBe("again");
  });
});

describe("running clocks", () => {
  it("count from the server's value, and from a new one a refresh brings to the same element", () => {
    document.body.innerHTML = `<span data-ms="61000">1:01</span>`;
    const countOn = startClocks(document);
    const el = document.querySelector<HTMLElement>("[data-ms]") as HTMLElement;
    expect(el.textContent).toBe("1:01");
    el.dataset.ms = "3600000";
    countOn();
    expect(el.textContent).toBe("1:00:00");
  });
});

describe("what follows the journal", () => {
  it("a run's page its run, Runs any run, a knowledge page only its own run", () => {
    expect(followsJournal("run", "run_a", ["run_a"])).toBe(true);
    expect(followsJournal("run", "run_a", ["run_b"])).toBe(false);
    expect(followsJournal("runs", undefined, ["run_b"])).toBe(true);
    // pilot: a knowledge tab re-rendered on every event of the runs open in other tabs, and the server hung
    expect(followsJournal("knowledge", undefined, ["run_b"])).toBe(false);
    expect(followsJournal("knowledge", "run_ask", ["run_ask"])).toBe(true);
  });
});
