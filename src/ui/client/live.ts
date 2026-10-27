import { Idiomorph } from "idiomorph";
import { T } from "./strings.ts";

/**
 * The page follows the journal: each `[data-live]` region is morphed to the server's fresh rendering —
 * only what changed changes, so focus, a caret, an open fold, a popover and a turning spinner stay as
 * they were (before, a region was replaced whole and each of these needed a rule of its own).
 */

/** A spinner keeps its turn: its phase comes from the page's clock, so a new one goes on where the old one was. */
export const SPIN_MS = 1000;

/** Spinners without a phase yet (the page's first ones, the ones a refresh brought) get the clock's. */
export function inPhase(root: ParentNode): void {
  for (const s of root.querySelectorAll<HTMLElement>(".spin"))
    if (!s.style.animationDelay) s.style.animationDelay = `${-(performance.now() % SPIN_MS)}ms`;
}

/** A field in the region differs from how the server rendered it: a person changed it and has not sent it. */
export function edited(region: Element): boolean {
  return [
    ...region.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    ),
  ].some((f) => {
    if (f instanceof HTMLInputElement && (f.type === "checkbox" || f.type === "radio"))
      return f.checked !== f.defaultChecked;
    if (f instanceof HTMLSelectElement) return [...f.options].some((o) => o.selected !== o.defaultSelected);
    if (f instanceof HTMLInputElement && ["hidden", "submit", "button"].includes(f.type)) return false;
    return f.value !== (f as HTMLInputElement | HTMLTextAreaElement).defaultValue;
  });
}

/** What a person set stays theirs: a fold opened or closed, a spinner's phase. */
function keepAttribute(name: string, node: Element): boolean {
  if (name === "open" && node.tagName === "DETAILS") return false;
  if (name === "style" && node.classList.contains("spin")) return false;
  return true;
}

/**
 * Each live region of `doc` morphed to its namesake in `next`. A region gone from `next` keeps an empty
 * slot (a finished run has no «now» card); a region with unsent changes waits for them — a comment, an
 * amount, ticked boxes, a picked answer (pilot: a refresh while reviewing a module's claims cleared the ticks).
 */
export function morphRegions(doc: Document, next: Document): void {
  const fresh = new Map<string, HTMLElement>();
  for (const el of next.querySelectorAll<HTMLElement>("[data-live]"))
    if (el.dataset.live && !fresh.has(el.dataset.live)) fresh.set(el.dataset.live, el);
  for (const el of [...doc.querySelectorAll<HTMLElement>("[data-live]")]) {
    if (!el.isConnected || edited(el)) continue;
    const name = el.dataset.live ?? "";
    let to = fresh.get(name);
    if (!to) {
      to = doc.createElement("div");
      to.dataset.live = name;
      to.hidden = true;
    }
    Idiomorph.morph(el, to, {
      morphStyle: "outerHTML",
      ignoreActiveValue: true,
      restoreFocus: true,
      callbacks: { beforeAttributeUpdated: (attr, node) => keepAttribute(attr, node) },
    });
  }
  inPhase(doc);
  const title = next.querySelector("title");
  if (title?.textContent) doc.title = title.textContent;
}

/** Running clocks count on between refreshes: the server's value plus the time since that value came. */
export function startClocks(doc: Document = document): () => void {
  const arrived = new WeakMap<Element, { ms: number; at: number }>();
  const clockOf = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };
  const countOn = () => {
    const now = performance.now();
    for (const el of doc.querySelectorAll<HTMLElement>("[data-ms]")) {
      const ms = Number(el.dataset.ms);
      let a = arrived.get(el);
      // a refresh may keep the element and bring a new value: it counts from that one
      if (!a || a.ms !== ms) {
        a = { ms, at: now };
        arrived.set(el, a);
      }
      const text = clockOf(a.ms + now - a.at);
      if (el.textContent !== text) el.textContent = text;
    }
  };
  countOn();
  return countOn;
}

/**
 * Whether a journal event about `runs` refreshes the page: a run's page — its own run's events; the Runs
 * page — any; a knowledge page — only its own run (an answer being written), else none: it shows files,
 * not runs (pilot: a knowledge tab re-rendered on every event of the runs open in other tabs, each time
 * reading the journal, and the server stopped answering them all).
 */
export function followsJournal(
  page: string | undefined,
  runId: string | undefined,
  runs?: readonly string[],
): boolean {
  if (runId) return (runs ?? []).includes(runId);
  return page !== "knowledge";
}

/** The live page: the journal's events (SSE) and the page's tick bring refreshes, at most one each 2 s. */
export function startLive(hooks: { afterRefresh: () => void; onJournal: () => void }): () => Promise<void> {
  const body = document.body;
  const status = document.querySelector<HTMLElement>(".live");
  const say = (state: string, text: string) => {
    if (!status) return;
    status.dataset.state = state;
    const label = status.querySelector(".label");
    if (label) label.textContent = text;
  };
  let busy = false;
  let again = false;
  const refresh = async (): Promise<void> => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const res = await fetch(location.href, {
        headers: { "X-Jarvis-Refresh": "1" },
        credentials: "same-origin",
      });
      if (!res.ok) return;
      // the page moved on (a launch whose run began): follow it
      if (res.redirected && res.url !== location.href) {
        location.href = res.url;
        return;
      }
      morphRegions(document, new DOMParser().parseFromString(await res.text(), "text/html"));
      hooks.afterRefresh();
    } catch {
      /* the next event tries again */
    } finally {
      busy = false;
      if (again) {
        again = false;
        setTimeout(refresh, 50);
      }
    }
  };
  // a busy run writes events many times a second: the page follows at most every 2 s (each render
  // reads the whole run on the server, and a click waits behind them there)
  let lastRefresh = 0;
  let soonTimer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    if (soonTimer) return;
    const wait = Math.max(0, lastRefresh + 2000 - Date.now());
    soonTimer = setTimeout(() => {
      soonTimer = undefined;
      lastRefresh = Date.now();
      void refresh();
    }, wait);
  };
  if (window.EventSource) {
    const runId = body.dataset.run;
    const source = new EventSource(`/live${runId ? `?run=${encodeURIComponent(runId)}` : ""}`);
    source.onopen = () => say("live", "live");
    source.onerror = () => say("lost", T("reconnecting…"));
    let journalSoon: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("journal", (e) => {
      let data: { runs?: string[] } = {};
      try {
        data = JSON.parse((e as MessageEvent<string>).data) as { runs?: string[] };
      } catch {
        /* an event without data: refresh all the same */
      }
      if (followsJournal(body.dataset.page, runId, data.runs)) soon();
      clearTimeout(journalSoon);
      journalSoon = setTimeout(hooks.onJournal, 1000);
    });
  }
  const tick = Number(body.dataset.tick || 0);
  if (tick > 0) setInterval(() => void refresh(), tick);
  return refresh;
}
