import { store, stored, targetOf } from "./dom.ts";

/**
 * «New task»: Where (a list of places in a popover) and How far (segments); the line under the box, the
 * button and what cannot run in the place follow the choice. The research to start from, the restart and
 * the note on linked services are looked up as the task is typed (GET /runs/from).
 */
export function initNewTask(): void {
  const form = document.querySelector<HTMLFormElement>("form[data-newtask]");
  if (!form) return;
  const startFrom = form.querySelector<HTMLElement>("[data-from]");
  const where = form.querySelector<HTMLDetailsElement>("[data-where]");
  const whatLine = form.querySelector<HTMLElement>("[data-said]");
  const taskField = form.elements.namedItem("task") as HTMLTextAreaElement | null;
  const LAST = "jarvis.newtask.repo";
  const radios = (name: string) => [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
  const place = () =>
    radios("repo").find((r) => r.checked) ?? form.querySelector<HTMLInputElement>('input[name="repo"]');
  const how = () => radios("workflow").find((r) => r.checked);
  const keyOf = (text: string) => text.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];

  const sync = () => {
    const p = place();
    const across = !!p?.hasAttribute("data-across");
    const name = p?.dataset.name ?? "";
    for (const r of radios("workflow")) {
      const off = across && r.hasAttribute("data-one-only");
      r.disabled = off;
      const label = r.closest("label");
      if (!label) continue;
      if (off) label.title = form.dataset.oneOnlyTitle ?? "";
      else label.removeAttribute("title");
    }
    let h = how();
    if (!h || h.disabled) {
      h =
        radios("workflow").find((r) => r.value === "sdd" && !r.disabled) ??
        radios("workflow").find((r) => !r.disabled);
      if (h) h.checked = true;
    }
    if (!h || !whatLine) return;
    const acrossHere = across && h.dataset.acrossWhat;
    const b = document.createElement("b");
    b.textContent = h.dataset.label ?? "";
    const key = keyOf(taskField?.value ?? "");
    whatLine.replaceChildren(
      b,
      `${acrossHere ? ` ${form.dataset.acrossWord ?? ""} — ${h.dataset.acrossWhat}` : ` — ${h.dataset.what ?? ""}`}.${
        key ? ` ${(form.dataset.reads ?? "").replace("{key}", key)}` : ""
      }`,
    );
    if (where && p) {
      const summary = where.querySelector("summary");
      if (!summary) return;
      const icon = document.createElement("span");
      icon.className = across ? "ic all" : "ic";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = across ? "◎" : (name[0] ?? "?").toUpperCase();
      const nm = document.createElement("span");
      nm.textContent = name;
      const badge = p.closest("label")?.querySelector(".badge");
      const caret = summary.querySelector(".car");
      summary.replaceChildren(icon, nm, ...(badge ? [badge.cloneNode(true)] : []), ...(caret ? [caret] : []));
    }
  };

  // the kind of task: the line says what was picked and why; «Change» opens the kinds, «Auto» goes back
  const kindLine = form.querySelector<HTMLElement>("[data-kind-line]");
  const showKind = (headers: Headers) => {
    if (!kindLine) return;
    const name = headers.get("X-Task-Kind-Name");
    const why = headers.get("X-Task-Kind-Why");
    const nameEl = kindLine.querySelector("[data-kind-name]");
    const whyEl = kindLine.querySelector("[data-kind-why]");
    if (name && nameEl) nameEl.textContent = decodeURIComponent(name);
    if (why && whyEl) whyEl.textContent = `— ${decodeURIComponent(why)}`;
  };

  // «From a step of an earlier run»: the button says where the new run starts
  const go = form.querySelector<HTMLButtonElement>("[data-go]");
  const goText = go?.textContent ?? "";
  const goLabel = () => {
    if (!go) return;
    const earlier = form.querySelector<HTMLElement>("[data-earlier]");
    const mode = radios("from-mode").find((r) => r.checked)?.value;
    const step = radios("restart").find((r) => r.checked)?.dataset.step;
    go.textContent =
      earlier && mode === "step" && step
        ? (earlier.dataset.goLabel ?? "{step}").replace("{step}", step)
        : goText;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = "";
  const look = () => {
    const p = place();
    const h = how();
    const k = radios("kind").find((r) => r.checked);
    const q = new URLSearchParams({
      task: taskField?.value ?? "",
      workflow: h ? h.value : "",
      repo: p ? p.value : "",
      kind: k ? k.value : "",
    }).toString();
    if (q === asked) return;
    asked = q;
    fetch(`/runs/from?${q}`, { headers: { Accept: "text/html" } })
      .then((res) => {
        if (res.ok && asked === q) showKind(res.headers);
        return res.ok ? res.text() : "";
      })
      .then((text) => {
        if (asked === q && startFrom) startFrom.innerHTML = text;
        goLabel();
      })
      .catch(() => {});
  };
  const closeWhere = () => {
    if (!where) return;
    where.open = false;
    where.querySelector("summary")?.focus();
  };
  const choosePlace = (radio: HTMLInputElement, close: boolean) => {
    radio.checked = true;
    store(LAST, radio.value);
    if (close) closeWhere();
    sync();
    look();
  };

  // the place chosen last time, unless the page is of one repository's runs
  if (!new URL(location.href).searchParams.get("repo")) {
    const last = stored(LAST, "");
    const r = last ? radios("repo").find((x) => x.value === last) : undefined;
    if (r) r.checked = true;
  }

  form.addEventListener("input", (e) => {
    const t = targetOf(e) as HTMLInputElement | null;
    if (t?.hasAttribute("data-where-find") && where) {
      const q = t.value.trim().toLowerCase();
      let shown = 0;
      for (const opt of where.querySelectorAll<HTMLElement>(".opt")) {
        const hit = !q || (opt.dataset.find ?? "").includes(q);
        opt.hidden = !hit;
        if (hit) shown++;
      }
      const none = where.querySelector<HTMLElement>("[data-where-none]");
      if (none) none.hidden = shown > 0;
      return;
    }
    if (t?.name !== "task") return;
    sync();
    clearTimeout(timer);
    timer = setTimeout(look, 300);
  });
  form.addEventListener("change", (e) => {
    const t = targetOf(e) as HTMLInputElement | null;
    if (!t) return;
    // arrows move the choice and keep the list open; a click or Enter closes it
    if (t.name === "repo") choosePlace(t, false);
    else if (t.name === "restart" || t.name === "from-mode") {
      // a step picked: the start is that step; «From the start» unpicks nothing, it only switches
      if (t.name === "restart") {
        const step = radios("from-mode").find((r) => r.value === "step");
        if (step) step.checked = true;
      }
      goLabel();
    } else if (t.name === "workflow" || t.name === "kind") {
      sync();
      look();
    }
  });
  if (where) {
    where.addEventListener("click", (e) => {
      const t = targetOf(e);
      if (t?.closest(".opt") && t instanceof HTMLInputElement) choosePlace(t, true);
    });
    where.addEventListener("keydown", (e) => {
      const t = targetOf(e) as HTMLInputElement | null;
      if (!t) return;
      if (e.key === "Enter" && t.name === "repo") {
        e.preventDefault();
        choosePlace(t, true);
      } else if (e.key === "Enter" && t.hasAttribute("data-where-find")) {
        e.preventDefault();
        const first = [...where.querySelectorAll<HTMLElement>(".opt")].find((o) => !o.hidden);
        const input = first?.querySelector("input");
        if (input) choosePlace(input, true);
      } else if (e.key === "Escape" && where.open) closeWhere();
    });
    where.addEventListener("toggle", () => {
      if (!where.open) return;
      const find = where.querySelector<HTMLInputElement>("[data-where-find]");
      (find ?? place())?.focus();
    });
    document.addEventListener("click", (e) => {
      const t = targetOf(e);
      if (where.open && t && !where.contains(t)) where.open = false;
    });
  }
  // the note on linked services: its link changes only Where
  form.addEventListener("click", (e) => {
    const cross = targetOf(e)?.closest<HTMLElement>("[data-cross]");
    if (!cross) return;
    const r = radios("repo").find((x) => x.value === cross.dataset.repo);
    if (r) choosePlace(r, false);
  });
  sync();
  look();
}
