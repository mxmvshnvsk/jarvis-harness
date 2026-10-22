import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type UiPages, uiPages } from "../helpers/uiPages.ts";

/**
 * The pages in a real browser, by geometry rather than pixels (fonts differ from machine to machine):
 * no sideways scroll, the bottom strip at the bottom while the page scrolls, the side column in sight,
 * the header's parts apart — on a wide screen and a phone, light and dark. Pilot: a dock mid-page, the
 * decision under the questions scrolled away, the decision column gone with the document.
 *
 * Needs a Chromium: Playwright's (PLAYWRIGHT_BROWSERS_PATH) or the installed Chrome; without one the
 * checks are skipped with a word. JARVIS_SCREENS=<dir> keeps a screenshot of each page and size.
 */
let pages: UiPages;
let browser: Browser | undefined;
let why = "";

beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch (first) {
    try {
      browser = await chromium.launch({ channel: "chrome" });
    } catch {
      why = `no Chromium to run the layout checks in: ${first instanceof Error ? first.message.split("\n")[0] : first}`;
      console.warn(why);
    }
  }
  if (browser) pages = await uiPages();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await pages?.close();
});

const SIZES = [
  { name: "wide", width: 1366, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

async function open(path: string, size: (typeof SIZES)[number], scheme: "light" | "dark"): Promise<Page> {
  const context = await (browser as Browser).newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: scheme,
  });
  await context.addCookies([
    { name: `jarvis_ui_${pages.ui.port}`, value: pages.ui.token, url: pages.url("/") },
  ]);
  const page = await context.newPage();
  // no live refresh in the middle of a measurement
  await page.route("**/live**", (route) => route.abort());
  await page.goto(pages.url(path));
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.JARVIS_SCREENS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** The page's layout faults where it stands: what a person would see as broken. */
async function faults(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > window.innerWidth + 1)
      out.push(`sideways scroll: the page is ${root.scrollWidth}px wide in ${window.innerWidth}px`);
    const dock = document.querySelector<HTMLElement>("main > .dock");
    if (dock && !dock.hidden && dock.offsetHeight > 0) {
      const r = dock.getBoundingClientRect();
      const end = document.querySelector("main")?.getBoundingClientRect().bottom ?? 0;
      // stuck to the screen's bottom, unless the page ends above it
      if (Math.abs(r.bottom - Math.min(window.innerHeight, end)) > 2)
        out.push(
          `the dock is not at the bottom: its bottom at ${Math.round(r.bottom)} of ${window.innerHeight}`,
        );
    }
    const top = document.querySelector(".top");
    if (top) {
      const parts = [...top.querySelectorAll<HTMLElement>(":scope > * > *")].filter((e) => e.offsetWidth > 0);
      for (let i = 0; i < parts.length; i++)
        for (let j = i + 1; j < parts.length; j++) {
          const a = (parts[i] as HTMLElement).getBoundingClientRect();
          const b = (parts[j] as HTMLElement).getBoundingClientRect();
          const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const vert = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlap > 2 && vert > 2)
            out.push(
              `header parts overlap: ${(parts[i] as HTMLElement).className} / ${(parts[j] as HTMLElement).className}`,
            );
        }
    }
    return out;
  });
}

describe("the pages' layout in a browser", () => {
  for (const name of ["runs", "run", "questions", "review", "knowledge"])
    for (const size of SIZES)
      for (const scheme of ["light", "dark"] as const)
        it(`${name}, ${size.name}, ${scheme}: no sideways scroll, the dock at the bottom while it scrolls`, async (t) => {
          if (!browser) return t.skip(why);
          const page = await open(pages.paths[name] as string, size, scheme);
          try {
            const at: string[] = [];
            for (const where of ["top", "middle", "end"] as const) {
              await page.evaluate((w) => {
                const h = document.documentElement.scrollHeight;
                window.scrollTo(0, w === "top" ? 0 : w === "middle" ? h / 2 : h);
              }, where);
              await page.waitForTimeout(50);
              for (const f of await faults(page)) at.push(`${where}: ${f}`);
              await shot(page, `${name}-${size.name}-${scheme}-${where}`);
            }
            expect(at).toEqual([]);
          } finally {
            await page.context().close();
          }
        });

  it("the decision column stays in sight beside a long document, its buttons too", async (t) => {
    if (!browser) return t.skip(why);
    const page = await open(pages.paths.review as string, SIZES[0], "light");
    try {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
      await page.waitForTimeout(50);
      const box = await page.evaluate(() => {
        const r = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
        const aside = r(".cols > aside.aside");
        const accept = r('.cols > aside.aside button[value="approve"]');
        return { aside, accept, height: window.innerHeight, header: r(".top")?.bottom ?? 0 };
      });
      expect(box.aside?.top).toBeGreaterThanOrEqual(box.header - 1);
      expect(box.aside?.bottom).toBeLessThanOrEqual(box.height + 1);
      expect(box.accept?.bottom).toBeLessThanOrEqual(box.height);
      expect(box.accept?.top).toBeGreaterThanOrEqual(box.header);
    } finally {
      await page.context().close();
    }
  });
});
