import { basename } from "node:path";
import { kindOfTask } from "../app/taskKind.ts";
import { TASK_KINDS } from "../core/domain/run.ts";
import type { CatalogLink, NamedService } from "../knowledge/catalog.ts";
import { type Html, html } from "./html.ts";
import { plural, t, th } from "./i18n.ts";
import { KIND_NAME, kindWhy } from "./kinds.ts";
import type { Actions, LaunchView } from "./pages.ts";

/**
 * "New task" on the Runs page: one box for the task with two controls under it — Where (a button that
 * opens the list of places: all services, one service, other repositories) and How far (the same four
 * everywhere; what cannot run in the place is disabled with why, not hidden) — and a button named after
 * the action and the place. A plain form underneath: radios for both, so it works without the script.
 */

/** A place a task can run in. */
export interface StartPlace {
  readonly root: string;
  readonly name: string;
  /** The knowledge repository: a task there is across its services. */
  readonly across?: boolean;
  /** A service's kind from the map: backend, frontend, library. */
  readonly kind?: string;
  /** The knowledge repository: how many services its map has. */
  readonly services?: number;
  readonly group: "across" | "service" | "other";
}

export interface StartForm {
  readonly places: readonly StartPlace[];
  readonly current?: string;
  readonly launches: readonly LaunchView[];
  readonly homeDir: string;
  readonly notice?: Html;
  /** The project reads related work by default (`relatedWork.enabled`, ADR-0026): the box starts ticked. */
  readonly related?: boolean;
}

/**
 * How far a task goes: the same three in every place. `research` alone is not offered: a spec starts
 * with the same research and goes on to requirements a person approves; a question is for Ask, and
 * `jarvis research` stays for the terminal and the runs made with it.
 */
export type HowFar = "fix" | "sdd" | "spec";

interface HowFarDef {
  readonly id: HowFar;
  readonly label: string;
  /** In one service or repository: the button (`{place}` is the place's name), and what it does. */
  readonly one: { readonly what: string };
  /** Across services; none when it runs in one service only. */
  readonly across?: { readonly what: string };
}

/**
 * The three as the team names them, in English in every language and in the order a task grows:
 * specify, build; a bug fix on its own.
 */
export const HOW_FAR: readonly HowFarDef[] = [
  {
    id: "spec",
    label: "Specification",
    one: { what: "up to an approved spec; implement later" },
    across: { what: "one spec for all the services, approved; split later" },
  },
  {
    id: "sdd",
    label: "Implementation",
    one: {
      what: "requirements, a spec to approve, impact, plan, code, checks, review",
    },
    across: {
      what: "one spec, a subtask per service, the contract between them, delivery in order",
    },
  },
  {
    id: "fix",
    label: "Bugfix",
    one: { what: "research, a spec to approve, the fix, checks, review" },
  },
];

export const ONE_SERVICE_ONLY = "In one service only — pick it in Where";
// t("Specification") t("Implementation") t("Bugfix") t("All services") t("In one service only — pick it in Where")
// t("research, a spec to approve, the fix, checks, review") t("requirements, a spec to approve, impact, plan, code, checks, review")
// t("one spec, a subtask per service, the contract between them, delivery in order") t("up to an approved spec; implement later")
// t("one spec for all the services, approved; split later") t("Across services") t("One service") t("Other repositories with runs")

/**
 * The workflow a choice runs: Implement in the knowledge repository is the task across services;
 * research and spec there turn across services by themselves (src/app/subtasks.ts). Fix there is none.
 */
export function workflowOfChoice(how: string, across: boolean): string | undefined {
  if (across && how === "fix") return undefined;
  if (across && how === "sdd") return "sdd-cross";
  return how;
}

/** The places in the order of the list: all services, the services of the map, other repositories. */
export function placesOf(input: {
  readonly repos: readonly string[];
  readonly meta?: {
    readonly root: string;
    readonly repos: Readonly<Record<string, string>>;
    readonly kinds: Readonly<Record<string, string>>;
  };
}): StartPlace[] {
  const { meta } = input;
  const known = new Set(input.repos);
  const services = meta
    ? Object.entries(meta.repos)
        .filter(([, root]) => known.has(root))
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  const taken = new Set([...(meta ? [meta.root] : []), ...services.map(([, root]) => root)]);
  return [
    ...(meta
      ? [
          {
            root: meta.root,
            name: "All services",
            across: true,
            services: Object.keys(meta.repos).length,
            group: "across" as const,
          },
        ]
      : []),
    ...services.map(([name, root]) => {
      const kind = meta?.kinds[name];
      return { root, name, ...(kind ? { kind } : {}), group: "service" as const };
    }),
    ...input.repos
      .filter((r) => !taken.has(r))
      .map((root) => ({ root, name: basename(root) || root, group: "other" as const })),
  ];
}

const home = (path: string, dir: string) =>
  dir && path.startsWith(`${dir}/`) ? `~${path.slice(dir.length)}` : path;

const whatOf = (h: HowFarDef, place: StartPlace | undefined) =>
  place?.across && h.across
    ? html`<b>${t(h.label)}</b> ${t("across services")} — ${t(h.across.what)}.`
    : html`<b>${t(h.label)}</b> — ${t(h.one.what)}.`;
/** «All services» is a name of ours, the others are the repositories' own. */
const placeName = (p: StartPlace): string => (p.across ? t(p.name) : p.name);

function iconOf(place: StartPlace): Html {
  return place.across
    ? html`<span class="ic all" aria-hidden="true">◎</span>`
    : html`<span class="ic" aria-hidden="true">${(place.name[0] ?? "?").toUpperCase()}</span>`;
}

function badgeOf(place: StartPlace): Html | string {
  if (place.across) return html`<span class="badge">${t("knowledge repo")}</span>`;
  if (!place.kind) return "";
  return html`<span class="badge${place.kind === "library" ? " lib" : ""}">${place.kind}</span>`;
}

const GROUPS: ReadonlyArray<[StartPlace["group"], string]> = [
  ["across", "Across services"],
  ["service", "One service"],
  ["other", "Other repositories with runs"],
];

function whereHtml(places: readonly StartPlace[], chosen: StartPlace | undefined, homeDir: string): Html {
  const label = (p: StartPlace | undefined) =>
    p ? html`${iconOf(p)}<span data-where-name>${placeName(p)}</span>${badgeOf(p)}` : html`<span>—</span>`;
  if (places.length < 2)
    return html`<input type="hidden" name="repo" value="${chosen?.root ?? ""}"><span class="pick still" title="${home(chosen?.root ?? "", homeDir)}">${label(chosen)}</span>`;
  const groups = GROUPS.map(([g, title]) => [t(title), places.filter((p) => p.group === g)] as const).filter(
    ([, ps]) => ps.length > 0,
  );
  const option = (p: StartPlace) =>
    html`<label class="opt" data-find="${`${p.name} ${p.root}`.toLowerCase()}"><input type="radio" name="repo" value="${p.root}" data-name="${placeName(p)}"${p.across ? " data-across" : ""}${p === chosen ? " checked" : ""}><span class="ck" aria-hidden="true">✓</span><span class="nm">${placeName(p)}</span>${badgeOf(p)}<span class="p">${home(p.root, homeDir)}${p.services !== undefined ? ` · ${plural(p.services, "service")}` : ""}</span></label>`;
  return html`<details class="where" data-where>
<summary class="pick" title="${t("Where it runs")}" aria-label="${t("Where it runs")}">${label(chosen)}<span class="car" aria-hidden="true">▾</span></summary>
<div class="pop" role="group" aria-label="${t("Where it runs")}">
${places.length > 6 ? html`<input type="search" class="find" data-where-find placeholder="${t("Find a service or repository")}" aria-label="${t("Find a service or repository")}">` : ""}
${groups.map(([title, ps]) => html`<div class="grp">${title}</div>${ps.map(option)}`)}
<p class="none" data-where-none hidden>${t("Nothing found")}</p>
</div>
</details>`;
}

function howFarHtml(chosen: StartPlace | undefined, on: HowFar): Html {
  return html`<div class="seg" role="radiogroup" aria-label="${t("How far")}">${HOW_FAR.map((h) => {
    const off = chosen?.across === true && !h.across;
    return html`<label${off ? html` title="${t(ONE_SERVICE_ONLY)}"` : ""}><input type="radio" name="workflow" value="${h.id}" data-label="${t(h.label)}" data-what="${t(h.one.what)}"${h.across ? html` data-across-what="${t(h.across.what)}"` : " data-one-only"}${h.id === on ? " checked" : ""}${off ? " disabled" : ""}><span>${t(h.label)}</span></label>`;
  })}</div>`;
}

/**
 * The kind of task as a line under the form: what was picked and why — by the workflow, the words of the
 * task (src/app/taskKind.ts, sent back as the task is typed), or the person — and «Change» to pick one.
 * Pilot: a select under «More options» was one more thing to decide before every task.
 */
function kindLineHtml(): Html {
  const first = kindOfTask({ task: "" });
  return html`<div class="kindline" data-kind-line><span>${t("Kind of task")}</span><div class="kchip" role="radiogroup" aria-label="${t("Kind of task")}" title="${t("picks the skills and standards written for this kind of work")}"><label><input type="radio" name="kind" value="" checked><span><span class="ak">${t("Auto")} · </span><span data-kind-name>${t(KIND_NAME[first.kind])}</span></span></label>${TASK_KINDS.map((k) => html`<label><input type="radio" name="kind" value="${k}"><span>${t(KIND_NAME[k])}</span></label>`)}</div><span class="meta" data-kind-why>— ${kindWhy(first)}</span></div>`;
}

/** The form; a spec first and chosen in every place: agree on what to build before building it. */
export function newTaskHtml(start: StartForm, actions: Actions): Html {
  const chosen = start.places.find((p) => p.root === start.current) ?? start.places[0];
  const on: HowFar = "spec";
  const h = HOW_FAR.find((x) => x.id === on) as HowFarDef;
  return html`<section class="panel newtask" aria-labelledby="new-title" id="new">
<form method="post" action="/runs/new" data-newtask data-here="${t("this repository")}" data-across-word="${t("across services")}" data-reads="${t("Reads {key} at the start, with its pages and frames.")}" data-one-only-title="${t(ONE_SERVICE_ONLY)}"><input type="hidden" name="t" value="${actions.token}">
<h2 id="new-title">${t("New task")}</h2>
<div class="composer">
<textarea name="task" rows="3" required maxlength="4000" aria-label="${t("What to do")}" placeholder="${t("ABC-123 — or in words: what to find out, the bug, the change")}"></textarea>
<div class="cbar">${whereHtml(start.places, chosen, start.homeDir)}${howFarHtml(chosen, on)}<span class="grow"></span><button type="submit" class="btn primary" data-go>${t("Run")}</button></div>
</div>
<p class="what" data-said aria-live="polite">${whatOf(h, chosen)}</p>
${kindLineHtml()}
<div class="startfrom" data-from aria-live="polite"></div>
<details class="more"><summary>${t("More options")}</summary>
<label class="check"><input type="checkbox" name="autonomous" value="1"> ${t("Autonomous")} <span class="pill wait">experimental</span> <span class="meta">— ${t("full autonomy: no person needed, except when the task gets stuck or internet content comes into it")}</span></label>
<input type="hidden" name="related-box" value="1"><label class="check"><input type="checkbox" name="related" value="1"${start.related === false ? "" : " checked"}> ${t("Look at related tasks and their branches")} <span class="meta">— ${t("the branches and PRs of the epic's other tasks and the contract they change, before the spec")}</span></label>
<label class="check"><input type="checkbox" name="fresh" value="design"> ${t("Read the Figma frames again")} <span class="meta">— ${t("the design changed at the same link; past Jarvis's one-day cache, each frame is a Figma API call")}</span></label>
</details>
<p class="hint">${th("Runs in the background, as {cmd} (or the one chosen) would without a terminal; where it needs you, it waits here — decide on the page and it goes on.", { cmd: html`<code>jarvis spec "…"</code>` })}</p>
</form>
</section>`;
}

/**
 * Under "New task" in one service: the task names services the contract catalog links (ADR-0025 §7)
 * — a note with a link that changes only Where; nothing switches by itself.
 */
export function crossNoteHtml(named: readonly NamedService[], link: CatalogLink, metaRoot: string): Html {
  const names = named.map((n) => n.service);
  return html`<div class="cnote"><span aria-hidden="true">ⓘ</span><span>${t("The task names")} ${names.map((n, i) => html`${i === 0 ? "" : i === names.length - 1 ? ` ${t("and")} ` : ", "}<b>${n}</b>`)}, ${t("linked by")} <code>${link.what}</code>. ${names.length === 2 ? t("If both must change, run it in") : t("If they must change, run it in")} <button type="button" class="linkish" data-cross data-repo="${metaRoot}">${t("All services")}</button>.</span></div>`;
}
