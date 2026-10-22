/**
 * The strings the page's script says, in the page's language: src/ui/pages.ts puts them in a JSON block
 * (`#jarvis-strings`, from CLIENT_STRINGS of src/ui/assets.ts) that this reads — data, not code.
 */
let dict: Record<string, string> = {};

export function loadStrings(doc: Document = document): void {
  try {
    dict = JSON.parse(doc.getElementById("jarvis-strings")?.textContent || "{}") as Record<string, string>;
  } catch {
    dict = {};
  }
}

export function T(key: string, vars?: Record<string, string | number>): string {
  return (dict[key] ?? key).replace(/\{(\w+)\}/g, (all, name: string) =>
    vars && name in vars ? String(vars[name]) : all,
  );
}
