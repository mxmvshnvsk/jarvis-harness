import { closestOf, isField, store, stored, targetOf } from "./dom.ts";
import { inPhase } from "./live.ts";
import { T } from "./strings.ts";

/** What every page has: the header (theme, bell, indicators), keys, copy buttons, popovers, the toast. */

/** Recent searches as you type: the address keeps the query, the list comes with a refresh. */
export function initSearch(refresh: () => Promise<void>): void {
  const search = document.querySelector<HTMLInputElement>("[data-search]");
  if (!search) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const url = new URL(location.href);
      const q = search.value.trim();
      if (q) url.searchParams.set("q", q);
      else url.searchParams.delete("q");
      url.searchParams.delete("page");
      const repo = search.form?.elements.namedItem("repo") as HTMLInputElement | null;
      if (repo && !url.searchParams.has("repo")) url.searchParams.set("repo", repo.value);
      history.replaceState(null, "", url);
      void refresh();
    }, 250);
  });
}

export function initKeys(): void {
  // N anywhere but in a field: New task, its box in focus
  document.addEventListener("keydown", (e) => {
    if (e.key !== "n" && e.key !== "N") return;
    if (e.metaKey || e.ctrlKey || e.altKey || isField(targetOf(e))) return;
    const link = document.querySelector("[data-new-task]");
    if (!link) return;
    e.preventDefault();
    const box = document.querySelector<HTMLTextAreaElement>('form[data-newtask] textarea[name="task"]');
    if (box) {
      box.scrollIntoView({ block: "center" });
      box.focus();
    } else location.href = link.getAttribute("href") ?? "/";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const d of document.querySelectorAll<HTMLDetailsElement>("details[data-dismiss][open]")) {
      d.open = false;
      d.querySelector("summary")?.focus();
    }
  });
  // "New task" from the header: straight into the text box
  const focusNew = () => {
    if (location.hash === "#new") document.querySelector<HTMLTextAreaElement>("#new textarea")?.focus();
  };
  window.addEventListener("hashchange", focusNew);
  focusNew();
}

export function initClicks(): void {
  document.addEventListener("click", async (e) => {
    const close = closestOf(e, "[data-close]");
    if (close) {
      const d = close.closest("details");
      if (d) d.open = false;
      return;
    }
    const t = targetOf(e);
    for (const d of document.querySelectorAll<HTMLDetailsElement>("details[data-dismiss][open]"))
      if (t && !d.contains(t)) d.open = false;
    const copy = closestOf(e, "[data-copy]");
    if (copy) {
      const text = copy.dataset.copy ?? "";
      try {
        await navigator.clipboard.writeText(text);
        const was = copy.textContent;
        copy.textContent = T("Copied");
        setTimeout(() => {
          copy.textContent = was;
        }, 1500);
      } catch {
        window.prompt("Copy:", text);
      }
    }
  });
  // the rows of Recent a person picked stay for the next visit, like the theme
  document.addEventListener("click", (e) => {
    const size = closestOf(e, "[data-size]");
    if (size)
      document.cookie = `jarvis_recent_size=${size.dataset.size}; Path=/; SameSite=Strict; Max-Age=31536000`;
  });
  document.addEventListener("change", (e) => {
    const t = targetOf(e);
    if (t instanceof HTMLSelectElement && t.matches("select[data-autosubmit]")) t.form?.submit();
  });
  // a file a page refers to opens in the editor; the page stays where it is, a toast says what happened
  document.addEventListener("click", async (e) => {
    const ref = closestOf<HTMLAnchorElement>(e, 'a[href^="/open?"]');
    if (!ref || (e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey || (e as MouseEvent).shiftKey) return;
    e.preventDefault();
    let text = T("Could not reach jarvis ui");
    let ok = false;
    try {
      const res = await fetch(`${ref.getAttribute("href")}&js=1`, { credentials: "same-origin" });
      const body = (await res.json()) as { path?: string; opened?: string; error?: string; command?: string };
      ok = res.ok;
      text =
        (ok ? `↗ ${body.path} — opened in ${body.opened}` : (body.error ?? "")) +
        (body.command ? `\n$ ${body.command}` : "");
    } catch {
      /* the server is gone: the toast says so */
    }
    toast(text, ok);
  });
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, ok: boolean): void {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.className = `toast ${ok ? "ok" : "bad"}`;
  el.textContent = text;
  clearTimeout(toastTimer);
  const shown = el;
  toastTimer = setTimeout(() => shown.remove(), ok ? 2500 : 6000);
}

/**
 * The theme switch: the system's theme by default; a click flips light ↔ dark and remembers the pick in
 * a cookie (the server renders it next time) — unless the pick is the system's own again.
 */
export function initTheme(): void {
  const button = document.querySelector<HTMLElement>("[data-theme-switch]");
  if (!button) return;
  const root = document.documentElement;
  const systemDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const effective = () => root.dataset.theme || (systemDark?.matches ? "dark" : "light");
  const label = () => {
    const to = effective() === "dark" ? "light" : "dark";
    const text = T(to === "light" ? "Switch to the light theme" : "Switch to the dark theme");
    button.setAttribute("aria-label", text);
    button.title = text;
  };
  label();
  systemDark?.addEventListener?.("change", label);
  button.addEventListener("click", () => {
    const next = effective() === "dark" ? "light" : "dark";
    const system = systemDark?.matches ? "dark" : "light";
    if (next === system) {
      delete root.dataset.theme;
      document.cookie = "jarvis_theme=; Path=/; SameSite=Strict; Max-Age=0";
    } else {
      root.dataset.theme = next;
      document.cookie = `jarvis_theme=${next}; Path=/; SameSite=Strict; Max-Age=31536000`;
    }
    document
      .querySelector("meta[name=color-scheme]")
      ?.setAttribute("content", root.dataset.theme || "light dark");
    label();
  });
}

/**
 * System notifications: a run that starts waiting for you while this page is not in front says so through
 * the system; the bell asks the browser once (a click), the choice stays in this browser. A run whose card
 * waits in a terminal is left to the terminal, which notifies by itself.
 */
export function initBell(): () => Promise<void> {
  const bell = document.querySelector<HTMLElement>("[data-notify]");
  const canNotify = "Notification" in window;
  const notifyOn = () =>
    canNotify && Notification.permission === "granted" && stored("jarvis_notify", "off") === "on";
  const labelBell = () => {
    if (!bell) return;
    const state = !canNotify
      ? "unsupported"
      : Notification.permission === "denied"
        ? "blocked"
        : notifyOn()
          ? "on"
          : "off";
    bell.dataset.state = state;
    bell.setAttribute("aria-pressed", String(state === "on"));
    const title = {
      on: T("Notifications on: a run that waits for you says so — click to turn off"),
      off: T("Notify me when a run waits for me"),
      blocked: T("Notifications are blocked for this page in the browser settings"),
      unsupported: T("This browser has no system notifications"),
    }[state];
    bell.title = title;
    bell.setAttribute("aria-label", title);
  };
  const seenOf = (): Record<string, number> => {
    try {
      return (JSON.parse(stored("jarvis_notified", "{}")) as Record<string, number>) || {};
    } catch {
      return {};
    }
  };
  let baseline = true;
  type Waiting = {
    id: string;
    parked: number;
    what: string;
    task: string;
    workflow: string;
    terminal?: boolean;
    href?: string;
  };
  const checkWaiting = async (): Promise<void> => {
    if (!bell) return;
    let data: { waiting?: Waiting[] };
    try {
      const res = await fetch("/waiting.json", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) return;
      data = (await res.json()) as { waiting?: Waiting[] };
    } catch {
      return;
    }
    const seen = seenOf();
    const now = Date.now();
    for (const [key, at] of Object.entries(seen)) if (now - at > 7 * 86_400_000) delete seen[key];
    for (const w of data.waiting ?? []) {
      const key = `${w.id}:${w.parked}`;
      if (seen[key]) continue;
      seen[key] = now;
      // what waits when the page opens is on the page; a terminal at the card notifies by itself
      if (baseline || w.terminal || !notifyOn() || document.hasFocus()) continue;
      try {
        const n = new Notification(`Jarvis: ${w.what}`, {
          body: `${w.task}\n${w.workflow} · ${T("run")} ${w.id}`,
          tag: `jarvis-${key}`,
        });
        n.onclick = () => {
          window.focus();
          location.href = w.href || `/runs/${w.id}`;
          n.close();
        };
      } catch {
        /* a browser that only notifies from a service worker: the page still shows it */
      }
    }
    baseline = false;
    store("jarvis_notified", JSON.stringify(seen));
  };
  if (bell) {
    labelBell();
    void checkWaiting();
    setInterval(() => void checkWaiting(), 20_000);
    bell.addEventListener("click", async () => {
      if (!canNotify) return;
      if (Notification.permission === "granted") store("jarvis_notify", notifyOn() ? "off" : "on");
      else if (Notification.permission === "default") {
        const answer = await Notification.requestPermission();
        if (answer === "granted") store("jarvis_notify", "on");
      }
      labelBell();
    });
  }
  return checkWaiting;
}

interface IndicatorData {
  state: string;
  title: string;
  badge?: string;
  html: string;
  checking?: boolean;
}

interface Indicator {
  button: HTMLElement | null;
  pop: HTMLElement | null;
  refresh: () => Promise<void>;
  show: (data: IndicatorData) => void;
  setOpen: (open: boolean) => void;
}

/**
 * The header's indicators — models and MCP: a dot that says how they are doing, details in a popover on
 * click; the numbers come from the server's last round, so a click never waits for the journal.
 */
export function initIndicators(): () => Promise<void> {
  const indicators: Indicator[] = [];
  const indicator = (name: string, url: string): Indicator => {
    const button = document.querySelector<HTMLElement>(`[data-${name}]`);
    const pop = document.getElementById(`${name}-pop`);
    let busy = false;
    const show = (data: IndicatorData) => {
      if (!button || !pop) return;
      const dot = button.querySelector<HTMLElement>(".dot");
      if (dot) dot.dataset.state = data.state;
      button.title = data.title;
      button.setAttribute("aria-label", data.title);
      // ∞ while a model is not limited (unlimited hours, a pool with no limits)
      const badge = button.querySelector<HTMLElement>("[data-badge]");
      if (badge) {
        badge.textContent = data.badge || "";
        badge.hidden = !data.badge;
      }
      const body = pop.querySelector<HTMLElement>(`[data-${name}-body]`);
      if (body) {
        body.innerHTML = data.html;
        inPhase(body);
      }
      // the server is still collecting or checking: ask again shortly; the popover says it waits
      if (data.state === "pending" || data.checking) setTimeout(() => void refresh(), 1500);
    };
    const refresh = async () => {
      if (!button || !pop || busy) return;
      busy = true;
      try {
        const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
        if (res.ok) show((await res.json()) as IndicatorData);
      } catch {
        /* the next tick tries again */
      } finally {
        busy = false;
      }
    };
    const setOpen = (open: boolean) => {
      if (!button || !pop) return;
      pop.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      // on a phone the popover is fixed to the window's width, right under the button (the header wraps)
      pop.style.top =
        open && window.innerWidth <= 640 ? `${button.getBoundingClientRect().bottom + 8}px` : "";
      if (open) {
        for (const other of indicators) if (other.pop !== pop) other.setOpen(false);
        void refresh();
      }
    };
    if (button && pop) {
      void refresh();
      setInterval(() => void refresh(), 10_000);
      button.addEventListener("click", () => setOpen(pop.hidden));
    }
    return { button, pop, refresh, show, setOpen };
  };
  const models = indicator("models", "/models.json");
  const mcp = indicator("mcp", "/mcp.json");
  indicators.push(models, mcp);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const x of indicators)
      if (x.pop && !x.pop.hidden) {
        x.setOpen(false);
        x.button?.focus();
      }
  });
  document.addEventListener("click", async (e) => {
    const t = targetOf(e);
    // a click on something a refresh just replaced is no click outside
    if (!t?.isConnected) return;
    const check = t.closest<HTMLButtonElement>("[data-mcp-check]");
    if (check) {
      // "Check now": the server connects to each MCP server anew; the popover follows the check
      check.disabled = true;
      try {
        const res = await fetch("/mcp/check", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `t=${encodeURIComponent(check.dataset.mcpCheck ?? "")}`,
        });
        if (res.ok) mcp.show({ ...((await res.json()) as IndicatorData), checking: true });
      } catch {
        check.disabled = false;
      }
      return;
    }
    for (const x of indicators) if (x.pop && !x.pop.hidden && !t.closest("[data-pop-wrap]")) x.setOpen(false);
  });
  return async () => {
    await models.refresh();
    await mcp.refresh();
  };
}
