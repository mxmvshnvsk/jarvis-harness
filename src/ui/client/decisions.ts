import { closestOf, targetOf } from "./dom.ts";
import { T } from "./strings.ts";

/** Decisions on the page: the failed checks' choice, the open questions' answers, comments on diff lines. */

/** Failed checks: the button says what the chosen way does (it is in the dock, outside the card's form). */
export function syncChoice(): void {
  const r = document.querySelector<HTMLInputElement>('[data-choices] input[name="choice"]:checked');
  if (!r) return;
  for (const go of document.querySelectorAll("[data-choice-go]"))
    if (r.dataset.go) go.textContent = r.dataset.go;
  const title = r.closest("label")?.querySelector("b");
  for (const l of document.querySelectorAll("[data-choice-label]"))
    if (title) l.textContent = title.textContent;
}

/** The comments on lines of the diff that go back with the decision. */
export function comments(): Array<{ where: string; text: string }> {
  return [...document.querySelectorAll<HTMLTextAreaElement>(".thread textarea")]
    .map((t) => ({ where: t.dataset.where ?? "", text: t.value.trim() }))
    .filter((c) => c.text);
}

function count(): void {
  const n = comments().length;
  const btn = document.querySelector("[data-send-back]");
  if (btn)
    btn.textContent =
      n > 0
        ? T(n === 1 ? "Send back with {n} comment" : "Send back with {n} comments", { n })
        : T("Send back");
}

/** A comment on a line of the diff: a textarea under it. */
function openThread(line: HTMLElement | null): void {
  if (!line) return;
  const next = line.nextElementSibling;
  if (next?.classList.contains("thread")) {
    next.querySelector("textarea")?.focus();
    return;
  }
  const where = `${line.dataset.path}:${line.dataset.line}`;
  const box = document.createElement("div");
  box.className = "thread";
  box.innerHTML =
    '<label><span></span><textarea rows="2" name="line"></textarea></label>' +
    '<div class="actions"><button type="button" class="btn" data-drop>Remove</button></div>';
  const span = box.querySelector("span");
  if (span) span.textContent = `${where} · goes back with the decision`;
  const area = box.querySelector("textarea");
  if (!area) return;
  area.dataset.where = where;
  area.addEventListener("input", count);
  line.after(box);
  line.classList.add("commented");
  area.focus();
  count();
}

export function initDecisions(): void {
  document.addEventListener("change", (e) => {
    const t = targetOf(e) as HTMLInputElement | null;
    if (t?.name === "choice" && t.closest("[data-choices]")) syncChoice();
  });
  // an open question answered in one's own words: that answer is the one picked
  document.addEventListener("input", (e) => {
    const t = targetOf(e) as HTMLTextAreaElement | null;
    const n = t?.dataset?.own;
    if (!n || !t) return;
    const own = document.querySelector<HTMLInputElement>(`input[name="qa-${n}"][value="own"]`);
    if (own && t.value.trim()) own.checked = true;
  });
  document.addEventListener("click", (e) => {
    const add = closestOf(e, "[data-comment]");
    if (add) openThread(add.closest<HTMLElement>(".dl"));
    const drop = closestOf(e, "[data-drop]");
    if (drop) {
      const thread = drop.closest(".thread");
      thread?.previousElementSibling?.classList.remove("commented");
      thread?.remove();
      count();
    }
  });
  // a check's whole output: every fold open at once
  document.addEventListener("click", (e) => {
    const b = closestOf(e, "[data-unfold]");
    if (!b) return;
    const folds = [...(b.closest(".tf-log")?.querySelectorAll<HTMLDetailsElement>("details.fold") ?? [])];
    const open = folds.some((d) => !d.open);
    for (const d of folds) d.open = open;
    b.textContent = open ? T("Fold the rest") : T("Show every line");
  });
  // the decision form carries the line comments as `path:line — text` (ADR-0019 §5); a sent form's
  // buttons go quiet so a second click does not send it twice
  document.addEventListener("submit", (e) => {
    const form = targetOf(e);
    if (!(form instanceof HTMLFormElement)) return;
    if (form.matches("[data-decision]")) {
      const field = form.querySelector<HTMLInputElement>("input[name=lines]");
      if (field) field.value = JSON.stringify(comments());
    }
    for (const b of form.querySelectorAll("button"))
      setTimeout(() => {
        b.disabled = true;
      }, 0);
  });
  syncChoice();
}
