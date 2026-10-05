import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

/**
 * Deterministic check of what the onboarding mapper claims (agent mode). A claim survives only when
 * its evidence — a file and a verbatim excerpt — is really there. The model never grades itself.
 */
export interface EvidenceRef {
  readonly file: string;
  readonly line?: number | undefined;
  readonly quote: string;
}

export interface ClaimRef {
  readonly statement: string;
  readonly evidence: readonly EvidenceRef[];
}

export interface ModuleMapDoc {
  readonly module: string;
  readonly purpose: string;
  readonly publicApi: ReadonlyArray<{ symbol: string; file: string; description: string }>;
  readonly responsibilities: readonly ClaimRef[];
  readonly rules: readonly ClaimRef[];
  readonly terms: ReadonlyArray<{ term: string; synonyms: string[]; symbols: string[] }>;
  readonly unknowns: readonly string[];
}

export interface VerifiedEvidence {
  readonly file: string;
  /** The line where the excerpt really starts. */
  readonly line: number;
  readonly quote: string;
}

export interface VerifiedClaim {
  readonly statement: string;
  readonly evidence: VerifiedEvidence[];
}

export interface Dropped {
  readonly section: "publicApi" | "responsibilities" | "rules" | "term";
  readonly what: string;
  readonly why: string;
}

export interface VerifiedModuleMap {
  readonly module: string;
  readonly purpose: string;
  readonly publicApi: Array<{ symbol: string; file: string; description: string; line: number }>;
  readonly responsibilities: VerifiedClaim[];
  readonly rules: VerifiedClaim[];
  readonly terms: Array<{ term: string; synonyms: string[]; symbols: string[] }>;
  readonly unknowns: string[];
  readonly dropped: Dropped[];
}

export interface VerifyOptions {
  readonly root: string;
  /** Files the mapper may not quote (security.deniedPaths). */
  readonly isDenied?: (relative: string) => boolean;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

class Files {
  private readonly cache = new Map<string, string[] | null>();
  private readonly options: VerifyOptions;
  constructor(options: VerifyOptions) {
    this.options = options;
  }

  /** Lines of a repository file, or null when it is missing, outside the repo or denied. */
  lines(file: string): string[] | null {
    const cached = this.cache.get(file);
    if (cached !== undefined) return cached;
    let lines: string[] | null = null;
    const rel = normalize(file).split(sep).join("/");
    const safe =
      !isAbsolute(file) && !rel.startsWith("../") && rel !== ".." && !rel.split("/").includes(".git");
    if (safe && !this.options.isDenied?.(rel)) {
      const abs = join(this.options.root, rel);
      if (existsSync(abs) && statSync(abs).isFile() && statSync(abs).size < 2_000_000)
        lines = readFileSync(abs, "utf8").split(/\r?\n/);
    }
    this.cache.set(file, lines);
    return lines;
  }
}

/** Line (1-based) where `quote` starts in `lines`, preferring the one nearest to `hint`. */
function locate(lines: string[], quote: string, hint?: number): number | undefined {
  const q = squash(quote);
  if (!q) return undefined;
  const first = squash(quote.split("\n")[0] ?? quote);
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const here = squash(lines[i] ?? "");
    if (!here.includes(first)) continue;
    // a multi-line excerpt must continue over the following lines
    const span = squash(lines.slice(i, i + quote.split("\n").length + 1).join(" "));
    if (span.includes(q)) hits.push(i + 1);
  }
  if (hits.length === 0) return undefined;
  if (hint === undefined) return hits[0];
  return hits.reduce((best, h) => (Math.abs(h - hint) < Math.abs(best - hint) ? h : best));
}

function checkEvidence(files: Files, ev: EvidenceRef): VerifiedEvidence | string {
  const lines = files.lines(ev.file);
  if (!lines) return `${ev.file}: not a readable repository file`;
  const line = locate(lines, ev.quote, ev.line);
  if (line === undefined) return `${ev.file}: the excerpt is not in the file`;
  return { file: ev.file, line, quote: squash(ev.quote) };
}

function checkClaims(
  files: Files,
  section: "responsibilities" | "rules",
  claims: readonly ClaimRef[],
  dropped: Dropped[],
): VerifiedClaim[] {
  const kept: VerifiedClaim[] = [];
  for (const claim of claims) {
    const good: VerifiedEvidence[] = [];
    const bad: string[] = [];
    for (const ev of claim.evidence) {
      const result = checkEvidence(files, ev);
      if (typeof result === "string") bad.push(result);
      else good.push(result);
    }
    if (good.length > 0) kept.push({ statement: claim.statement, evidence: good });
    else dropped.push({ section, what: claim.statement, why: bad.join("; ") || "no evidence" });
  }
  return kept;
}

export function verifyModuleMap(doc: ModuleMapDoc, options: VerifyOptions): VerifiedModuleMap {
  const files = new Files(options);
  const dropped: Dropped[] = [];

  const publicApi: VerifiedModuleMap["publicApi"] = [];
  for (const api of doc.publicApi) {
    const lines = files.lines(api.file);
    if (!lines) {
      dropped.push({
        section: "publicApi",
        what: api.symbol,
        why: `${api.file}: not a readable repository file`,
      });
      continue;
    }
    const re = symbolPattern(api.symbol);
    const at = lines.findIndex((l) => re.test(l));
    if (at < 0) {
      dropped.push({
        section: "publicApi",
        what: api.symbol,
        why: `${api.file}: the symbol is not in the file`,
      });
      continue;
    }
    publicApi.push({ ...api, line: at + 1 });
  }

  const responsibilities = checkClaims(files, "responsibilities", doc.responsibilities, dropped);
  const rules = checkClaims(files, "rules", doc.rules, dropped);

  // A term stays when at least one of its symbols exists somewhere in the module's evidence files
  // or public API, or it names no symbol at all (pure vocabulary); unknown symbols are removed.
  const known = new Set<string>();
  for (const p of publicApi) known.add(p.symbol);
  const terms: VerifiedModuleMap["terms"] = [];
  for (const t of doc.terms) {
    const symbols = t.symbols.filter((s) => known.has(s) || symbolInModule(files, doc, s));
    if (t.symbols.length > 0 && symbols.length === 0) {
      dropped.push({
        section: "term",
        what: t.term,
        why: `none of its symbols (${t.symbols.join(", ")}) was found`,
      });
      continue;
    }
    terms.push({ term: t.term, synonyms: t.synonyms, symbols });
  }

  return {
    module: doc.module,
    purpose: doc.purpose,
    publicApi,
    responsibilities,
    rules,
    terms,
    unknowns: [...doc.unknowns],
    dropped,
  };
}

function symbolInModule(files: Files, doc: ModuleMapDoc, symbol: string): boolean {
  const re = symbolPattern(symbol);
  const seen = new Set<string>();
  const candidates = [
    ...doc.publicApi.map((a) => a.file),
    ...doc.responsibilities.flatMap((c) => c.evidence.map((e) => e.file)),
    ...doc.rules.flatMap((c) => c.evidence.map((e) => e.file)),
  ];
  for (const file of candidates) {
    if (seen.has(file)) continue;
    seen.add(file);
    if (files.lines(file)?.some((l) => re.test(l))) return true;
  }
  return false;
}

/**
 * A symbol as a whole token. `\b` only works between a word and a non-word character, so a symbol
 * that starts or ends with punctuation — a package name `@repo/shared`, an export path
 * `./eslint-config/*` — never matched inside quotes (pilot, 2026-10). The edge is guarded only where
 * the symbol itself has a word character there.
 */
export function symbolPattern(symbol: string): RegExp {
  const word = /[\w$]/;
  const head = word.test(symbol.charAt(0)) ? "(?<![\\w$])" : "";
  const tail = word.test(symbol.charAt(symbol.length - 1)) ? "(?![\\w$])" : "";
  return new RegExp(`${head}${escapeRegExp(symbol)}${tail}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
