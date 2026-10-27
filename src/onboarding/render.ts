import { basename } from "node:path";
import type { CodeContracts } from "../design/codeContracts.ts";
import type { ModuleFacts, ScanReport } from "./scan.ts";
import { isSweeping, type VerifiedModuleMap } from "./verify.ts";

/**
 * Knowledge skeletons rendered from a scan (`jarvis onboard`): facts only, short, no prose that a
 * model or a person has not checked. The marker line says the file is generated — it may be
 * regenerated with `--refresh` until a human removes the marker and takes it over.
 */
export const ONBOARD_MARKER =
  "<!-- jarvis:onboard — facts from `jarvis onboard`; edit freely; remove this line to stop regeneration -->";

const list = (items: readonly string[], none = "none found") => (items.length > 0 ? items.join(", ") : none);
const code = (s: string) => `\`${s}\``;

export function renderArchitecture(r: ScanReport, contracts?: CodeContracts): string {
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
  // the packages of a JVM tree share a long base: shown once, the modules by what follows it
  const base = commonBase(source.map((m) => m.path).filter((p) => p !== "(root)"));
  // modules of the tree first, then a few libraries: a JVM module imports dozens of packages
  const deps = (all: readonly string[]) => {
    const own = all.filter((d) => !d.startsWith("pkg:")).map((d) => code(short(d)));
    const libs = all.filter((d) => d.startsWith("pkg:"));
    const shown = libs.slice(0, 5).map(code);
    return (
      [
        ...own,
        ...shown,
        ...(libs.length > shown.length ? [`+${libs.length - shown.length} libraries`] : []),
      ].join(", ") || "—"
    );
  };
  const short = (p: string) => (base && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p);
  if (source.length === 0) lines.push("No source modules found.");
  else {
    const shown = source.slice(0, 40);
    if (base)
      lines.push(
        `Modules are the packages under ${code(`${base}/`)}, named below by the rest of their path.`,
        "",
      );
    lines.push("| module | files | lines | depends on | used by |", "|---|---:|---:|---|---|");
    for (const m of shown)
      lines.push(
        `| ${code(short(m.path))} | ${m.files} | ${m.lines} | ${deps(m.dependsOn)} | ${m.usedBy.map((d) => code(short(d))).join(", ") || "—"} |`,
      );
    if (source.length > shown.length)
      lines.push("", `… and ${source.length - shown.length} smaller modules.`);
    if (!r.graph.available)
      lines.push(
        "",
        `Module dependencies are not listed: no project graph for this stack${r.graph.reason ? ` (${r.graph.reason})` : ""}.`,
      );
  }
  if (contracts && (contracts.endpoints.length > 0 || contracts.topics.length > 0)) {
    const served = contracts.endpoints.filter((e) => e.direction !== "out");
    lines.push(
      "",
      "## Contracts",
      "",
      `${served.length} HTTP endpoints served in ${new Set(served.map((e) => e.file)).size} controllers, ${contracts.endpoints.length - served.length} calls to other services, ${contracts.topics.length} message topics in the config (${contracts.listeners.length} listeners) — listed in ${code(".jarvis/knowledge/contracts.md")}.`,
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

/** The directory every path is under, when they share one deeper than a single segment. */
function commonBase(paths: readonly string[]): string | undefined {
  if (paths.length < 2) return undefined;
  const split = paths.map((p) => p.split("/"));
  const first = split[0] as string[];
  let n = 0;
  while (n < first.length - 1 && split.every((p) => p.length > n + 1 && p[n] === first[n])) n += 1;
  return n >= 2 ? first.slice(0, n).join("/") : undefined;
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
  if (r.jvm && r.jvm.testRoots.length > 0) {
    lines.push("", "## Tests by source root", "");
    for (const t of r.jvm.testRoots)
      lines.push(
        `- ${code(t.root)}: ${t.tests} tests named ${t.suffixes.join(", ") || "—"}; they use ${t.frameworks.join(", ") || "—"}`,
      );
    if (r.jvm.shared.length > 0) {
      lines.push(
        "",
        "Shared test code — base classes, fixtures, configurations other tests extend or use (a new test starts from one of these):",
        "",
      );
      for (const s of r.jvm.shared)
        lines.push(`- ${code(s.file)} — used by ${s.tests} test${s.tests === 1 ? "" : "s"}`);
    }
  }
  if (r.jvm && r.jvm.libraries.length > 0)
    lines.push("", "## Libraries of the main code", "", `- ${r.jvm.libraries.join(", ")}`);
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

/** Marker of a module document written by the agent mapper (verified claims only). */
export const MODULE_MARKER =
  "<!-- jarvis:onboard-module — mapped by an agent; every claim was checked against the code; edit freely -->";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Knowledge document for one module: front matter `paths` scopes it to the module's files. */
/** Marks a claim the reviewer checks against the code before promoting. */
export const CHECK_MARK = "**[check: a generalisation; the excerpt shows one place]**";

/**
 * Statements of a rendered module document (Responsibilities, Rules to keep) that generalise
 * beyond their excerpts, and the document with each of them marked. Documents rendered before
 * the marker existed get it here, so `candidates show` and `promote` show what to check
 * (pilot: seven maps were promoted without a single marker).
 */
export function markSweeping(markdown: string): { markdown: string; sweeping: string[] } {
  const sweeping: string[] = [];
  let inClaims = false;
  const lines = markdown.split("\n").map((line) => {
    if (line.startsWith("## ")) inClaims = /^## (Responsibilities|Rules to keep)/.test(line);
    if (!inClaims || !line.startsWith("- ")) return line;
    const statement = line.slice(2).replace(/\s*\*\*\[check:.*$/, "");
    const marked = line.includes("**[check:");
    if (!marked && !isSweeping(statement)) return line;
    sweeping.push(statement);
    return marked ? line : `${line} ${CHECK_MARK}`;
  });
  return { markdown: lines.join("\n"), sweeping };
}

export function renderModuleDoc(
  map: VerifiedModuleMap,
  facts?: ModuleFacts,
  at?: { readonly commit?: string | undefined; readonly branch?: string | undefined },
): string {
  const lines: string[] = [
    "---",
    `tags: [module, generated]`,
    `paths: [${JSON.stringify(`${map.module}/**`)}]`,
    // the code it was mapped from: how stale it is counts from here (src/knowledge/freshness.ts)
    ...(at?.commit ? [`commit: ${at.commit}`] : []),
    ...(at?.branch ? [`branch: ${JSON.stringify(at.branch)}`] : []),
    "---",
    MODULE_MARKER,
    `# Module ${map.module}`,
    "",
    oneLine(map.purpose),
  ];
  if (facts) {
    lines.push(
      "",
      `Size: ${facts.files} files, about ${facts.lines} lines. Depends on: ${facts.dependsOn.map(code).join(", ") || "—"}. Used by: ${facts.usedBy.map(code).join(", ") || "—"}.`,
    );
  }
  if (map.publicApi.length > 0) {
    lines.push("", "## Public API", "");
    for (const a of map.publicApi)
      lines.push(`- ${code(a.symbol)} (${code(`${a.file}:${a.line}`)}) — ${oneLine(a.description)}`);
  }
  const claims = (title: string, items: VerifiedModuleMap["rules"]) => {
    if (items.length === 0) return;
    lines.push("", `## ${title}`, "");
    for (const c of items) {
      // a generalisation the excerpts cannot prove: the reviewer checks it before promoting
      const review = c.sweeping ? ` ${CHECK_MARK}` : "";
      lines.push(`- ${oneLine(c.statement)}${review}`);
      for (const e of c.evidence) lines.push(`  - ${code(`${e.file}:${e.line}`)}: ${code(e.quote)}`);
    }
  };
  claims("Responsibilities", map.responsibilities);
  claims("Rules to keep", map.rules);
  if (map.terms.length > 0) {
    lines.push("", "## Vocabulary", "", "| term | synonyms | symbols |", "|---|---|---|");
    for (const t of map.terms)
      lines.push(
        `| ${t.term} | ${t.synonyms.join(", ") || "—"} | ${t.symbols.map(code).join(", ") || "—"} |`,
      );
  }
  if (map.unknowns.length > 0) {
    lines.push("", "## Not established from the code", "");
    for (const u of map.unknowns) lines.push(`- ${oneLine(u)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The contracts of the code (`contracts.md`): the HTTP endpoints it serves by controller, the
 * ones it calls through clients of other services, the message topics of its config and their
 * listeners. Scoped by `paths` to the files that declare them: in the context of work on those.
 */
export function renderContracts(c: CodeContracts): string | undefined {
  if (c.endpoints.length === 0 && c.topics.length === 0 && (c.config ?? []).length === 0) return undefined;
  const files = [
    ...new Set([
      ...c.endpoints.map((e) => e.file),
      ...c.listeners.map((l) => l.file),
      ...c.topics.map((t) => t.file),
      ...(c.senders ?? []).map((x) => x.file),
      ...(c.config ?? []).map((x) => x.file),
    ]),
  ];
  const dirs = [...new Set(files.map((f) => f.slice(0, f.lastIndexOf("/"))))].sort();
  const lines: string[] = [
    "---",
    "tags: [contracts, generated]",
    `paths: [${dirs.map((d) => JSON.stringify(`${d}/**`)).join(", ")}]`,
    "---",
    ONBOARD_MARKER,
    "# Contracts of the code",
    "",
    "Read off the code without a model: what this service serves, what it calls, which topics it reads. A task's `METHOD /path` and topic names are checked against the same facts in the sources step.",
  ];
  const group = (items: readonly (typeof c.endpoints)[number][]) => {
    const by = new Map<string, Array<(typeof c.endpoints)[number]>>();
    for (const e of items) by.set(e.file, [...(by.get(e.file) ?? []), e]);
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  const served = c.endpoints.filter((e) => e.direction !== "out");
  const called = c.endpoints.filter((e) => e.direction === "out");
  if (served.length > 0) {
    lines.push("", `## HTTP endpoints served (${served.length})`);
    for (const [file, es] of group(served)) {
      lines.push("", `### ${basename(file).replace(/\.\w+$/, "")} (${code(file)})`);
      for (const e of [...es].sort(
        (a, b) =>
          (a.path ?? "").localeCompare(b.path ?? "") || (a.method ?? "").localeCompare(b.method ?? ""),
      ))
        lines.push(
          `- ${code(`${e.method ?? "ANY"} ${e.path ?? ""}`)}${e.key ? ` — ${code(e.key)}` : ""}${e.line ? ` :${e.line}` : ""}`,
        );
    }
  }
  if (called.length > 0) {
    lines.push("", `## Calls to other services (${called.length})`);
    for (const [file, es] of group(called)) {
      lines.push(
        "",
        `### ${es[0]?.client ? `${code(es[0].client)} through ` : ""}${basename(file).replace(/\.\w+$/, "")} (${code(file)})`,
      );
      for (const e of es)
        lines.push(`- ${code(`${e.method ?? "ANY"} ${e.path ?? ""}`)}${e.key ? ` — ${code(e.key)}` : ""}`);
    }
  }
  if (c.topics.length > 0) {
    lines.push(
      "",
      `## Message topics (${c.topics.length})`,
      "",
      "| property | topic | config | listened to by | sent by |",
      "|---|---|---|---|---|",
    );
    for (const t of [...c.topics].sort(
      (a, b) => a.property.localeCompare(b.property) || a.file.localeCompare(b.file),
    )) {
      const by = c.listeners
        .filter((l) => l.property === t.property || l.topic === t.topic)
        .map((l) => code(l.handler ?? basename(l.file)));
      const senders = (c.senders ?? []).filter((x) => x.topics.includes(t)).map((x) => code(x.type));
      lines.push(
        `| ${code(t.property)} | ${code(t.topic)} | ${basename(t.file)}${t.line ? `:${t.line}` : ""} | ${by.join(", ") || "—"} | ${senders.join(", ") || "—"} |`,
      );
    }
  }
  const unmatched = (c.senders ?? []).filter((x) => x.topics.length === 0);
  if (unmatched.length > 0)
    lines.push(
      "",
      `Senders whose topic is not read off the code: ${unmatched.map((x) => `${code(x.type)} (${basename(x.file)})`).join(", ")}.`,
    );
  if ((c.config ?? []).length > 0) {
    lines.push(
      "",
      `## Config read by the code (${(c.config ?? []).length})`,
      "",
      "| key | read by | how |",
      "|---|---|---|",
    );
    for (const b of c.config ?? [])
      lines.push(
        `| ${code(b.prefix ? `${b.key}.*` : b.key)} | ${code(b.type)} (${basename(b.file)}${b.line ? `:${b.line}` : ""}) | ${b.prefix ? "@ConfigurationProperties" : "@Value"} |`,
      );
  }
  if ((c.data ?? []).length > 0) {
    lines.push("", "## Stored data", "");
    for (const d of c.data ?? [])
      lines.push(
        d.kind === "collection"
          ? `- collection ${code(d.name)} — documents ${code(d.of)} (${basename(d.file)})`
          : `- repository ${code(d.name)} of ${code(d.of)} (${basename(d.file)})`,
      );
  }
  return `${lines.join("\n")}\n`;
}
