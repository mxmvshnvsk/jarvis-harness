import type { ScanReport } from "./scan.ts";

/**
 * Knowledge skeletons rendered from a scan (`jarvis onboard`): facts only, short, no prose that a
 * model or a person has not checked. The marker line says the file is generated — it may be
 * regenerated with `--refresh` until a human removes the marker and takes it over.
 */
export const ONBOARD_MARKER =
  "<!-- jarvis:onboard — facts from `jarvis onboard`; edit freely; remove this line to stop regeneration -->";

const list = (items: readonly string[], none = "none found") => (items.length > 0 ? items.join(", ") : none);
const code = (s: string) => `\`${s}\``;

export function renderArchitecture(r: ScanReport): string {
  const source = r.modules.filter((m) => m.role === "source" || m.role === "other");
  const lines: string[] = [
    "---",
    "tags: [architecture, generated]",
    "---",
    ONBOARD_MARKER,
    "# Architecture",
    "",
    "## Stack",
    "",
    `- Stacks: ${list(r.stacks)}${r.packageManager ? `; package manager ${r.packageManager}` : ""}`,
    `- Size: ${r.files} tracked files, about ${r.lines} lines of code`,
  ];
  const scopes = Object.entries(r.stackScopes);
  if (scopes.length > 1) {
    lines.push("- Areas with their own stack:");
    for (const [glob, stacks] of scopes) lines.push(`  - ${code(glob)} — ${stacks.join(", ")}`);
  }
  lines.push("", "## Modules", "");
  if (source.length === 0) lines.push("No source modules found.");
  else {
    const shown = source.slice(0, 40);
    lines.push("| module | files | lines | depends on | used by |", "|---|---:|---:|---|---|");
    for (const m of shown)
      lines.push(
        `| ${code(m.path)} | ${m.files} | ${m.lines} | ${m.dependsOn.map(code).join(", ") || "—"} | ${m.usedBy.map(code).join(", ") || "—"} |`,
      );
    if (source.length > shown.length)
      lines.push("", `… and ${source.length - shown.length} smaller modules.`);
    if (!r.graph.available)
      lines.push(
        "",
        `Module dependencies are not listed: no project graph for this stack${r.graph.reason ? ` (${r.graph.reason})` : ""}.`,
      );
  }
  if (r.entryPoints.length > 0) {
    lines.push("", "## Entry points", "");
    for (const e of r.entryPoints) lines.push(`- ${code(e)}`);
  }
  if (r.hotspots.length > 0) {
    lines.push("", "## Most changed files (recent history)", "");
    for (const h of r.hotspots) lines.push(`- ${code(h.file)} — ${h.commits} commits`);
  }
  if (r.docs.length > 0) {
    lines.push("", "## Existing documentation", "");
    const shown = r.docs.slice(0, 25);
    for (const d of shown) lines.push(`- ${code(d.path)} (${d.kind})`);
    if (r.docs.length > shown.length) lines.push(`- … and ${r.docs.length - shown.length} more`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderConventions(r: ScanReport): string {
  const lines: string[] = [
    "---",
    "tags: [conventions, generated]",
    "---",
    ONBOARD_MARKER,
    "# Conventions",
    "",
    "## Tooling",
    "",
  ];
  lines.push(
    `- Linters and formatters: ${r.tooling.linters.length > 0 ? r.tooling.linters.map((l) => `${l.tool} (${code(l.file)})`).join(", ") : "none configured"}`,
  );
  lines.push(`- Test frameworks: ${list(r.tooling.testFrameworks)}`);
  const layout = {
    colocated: "test files sit next to the code they test",
    "separate-dir": `test files live in ${r.tests.dirs.map(code).join(", ")}`,
    mixed: `test files are both next to the code and in ${r.tests.dirs.map(code).join(", ")}`,
    none: "no test files found",
  }[r.tests.layout];
  lines.push(`- Tests: ${r.tests.files} files; ${layout}`);
  lines.push(`- CI: ${list(r.tooling.ci, "none found")}`);
  if (r.commands.length > 0) {
    lines.push("", "## Commands", "");
    for (const c of r.commands) lines.push(`- ${c.name}: ${code(c.command)}`);
  }
  if (r.commits.sampled > 0) {
    const pct = (n: number) => Math.round((n / r.commits.sampled) * 100);
    lines.push("", "## Commits", "");
    if (r.commits.conventional > 0)
      lines.push(
        `- Conventional Commits in ${pct(r.commits.conventional)}% of the last ${r.commits.sampled}${r.commits.scopes.length > 0 ? `; common scopes: ${r.commits.scopes.join(", ")}` : ""}`,
      );
    if (r.commits.ticketPrefix > 0)
      lines.push(
        `- A tracker key prefixes ${pct(r.commits.ticketPrefix)}% of subjects (for example ABC-123)`,
      );
    if (r.commits.conventional === 0 && r.commits.ticketPrefix === 0)
      lines.push("- No common subject format detected");
  }
  return `${lines.join("\n")}\n`;
}

/** Fills the empty `tools.local: {}` of a freshly initialised project.yaml; anything else is left alone. */
export function applyCommands(
  projectYaml: string,
  commands: readonly { name: string; command: string }[],
): { text: string; applied: boolean } {
  if (commands.length === 0) return { text: projectYaml, applied: false };
  const re = /^(tools:\s*\n\s{2}local:) \{\}[ \t]*$/m;
  if (!re.test(projectYaml)) return { text: projectYaml, applied: false };
  const body = commands.map((c) => `    ${c.name}: ${JSON.stringify(c.command)}`).join("\n");
  return { text: projectYaml.replace(re, `$1\n${body}`), applied: true };
}
