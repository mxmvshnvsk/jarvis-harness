/** Small typed helpers over the DOM the pages render. */

/** The element an event happened on, or the nearest one above a text node. */
export function targetOf(e: Event): Element | null {
  const t = e.target;
  if (t instanceof Element) return t;
  return t instanceof Node ? t.parentElement : null;
}

/** The closest element matching `selector` from the event's target. */
export function closestOf<T extends Element = HTMLElement>(e: Event, selector: string): T | null {
  return (targetOf(e)?.closest(selector) as T | null) ?? null;
}

export function isField(el: Element | null): boolean {
  return !!el && ((el as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** localStorage that a private window or blocked site data may refuse: a fallback then. */
export function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* site data blocked: the choice lasts the page */
  }
}
