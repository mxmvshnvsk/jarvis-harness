import { createHash, randomBytes } from "node:crypto";
import { looksLikeSecretKey } from "../core/config/secrets.ts";

/**
 * Redactor (ADR-0010): one component applied at every boundary where text leaves a tool or
 * reaches a durable sink. Detectors in order of precision: exact literals (env/keychain values),
 * then patterns. Replacement is deterministic per run: `[REDACTED:<type>:<hash8>]`, so the same
 * secret maps to the same placeholder inside a run and to a different one in another run.
 */
export interface RedactionPattern {
  readonly name: string;
  readonly regex: RegExp;
}

export interface RedactorOptions {
  /** Values that must never appear in output (env secrets, resolved keychain entries). */
  readonly literals?: Iterable<string>;
  readonly patterns?: readonly RedactionPattern[];
  /** Per-run salt for the placeholder hash. */
  readonly salt?: string;
  readonly minLiteralLength?: number;
}

export interface RedactionReport {
  readonly text: string;
  readonly count: number;
  readonly byType: Record<string, number>;
  /**
   * What the high-entropy guess masked, without the value: its first characters, length and kinds of
   * characters, and the text just before it. A false positive (a long code name, a path) is told from
   * a secret by this; known secrets and pattern matches (tokens, keys) are never described.
   * Pilot: masked selector names were found only by reading the technical log.
   */
  readonly samples?: ReadonlyArray<RedactionSample>;
}

export interface RedactionSample {
  readonly placeholder: string;
  readonly shape: string;
  readonly before: string;
}

/** `isN… 34 chars, letters` — enough to recognise a code name, too little to rebuild a secret. */
export function shapeOf(value: string): string {
  const kinds = [
    /[a-z]/.test(value) && /[A-Z]/.test(value) ? "mixed case" : /[a-zA-Z]/.test(value) ? "letters" : "",
    /\d/.test(value) ? "digits" : "",
    /[^a-zA-Z\d]/.test(value) ? "symbols" : "",
  ].filter(Boolean);
  return `${value.slice(0, 3)}… ${value.length} chars, ${kinds.join(" + ")}`;
}

const MAX_SAMPLES = 5;

/** ADR-0010 §2 (3): well-known shapes. Order matters — specific prefixes before generic ones. */
export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [
  { name: "pem", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "aws-access-key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "github-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "slack-token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "openai-key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "bearer", regex: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: "basic-auth-url", regex: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@/]+(@)/gi },
  {
    name: "assignment",
    regex:
      /\b((?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{8,})/gi,
  },
];

const HIGH_ENTROPY = /\b[A-Za-z0-9+/_-]{32,}\b/g;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * A repository path made of words: `packages/shared/eslint-config/base`. Its entropy passes the
 * threshold, and right after `"path":` it sits in an assignment context, so tool arguments in the
 * technical log lost their paths (pilot, 2026-10). Words are lowercase kebab/snake case, camelCase or
 * ALL CAPS (`documentation/billing/CURRENCY_CODES.md`), at most 20 characters; a random token cut by slashes has longer or mixed-case runs and stays a secret.
 */
function looksLikePath(s: string): boolean {
  const segments = s.split("/").filter((seg) => seg.length > 0);
  if (segments.length < 2) return false;
  return segments.every((seg) =>
    seg
      .split(/[-_.]/)
      .every(
        (word) =>
          word.length === 0 ||
          (word.length <= 20 && /^(?:[a-z]+|[A-Z]+|[a-z]*(?:[A-Z][a-z]+)+)[0-9]{0,4}$/.test(word)) ||
          /^[0-9]{1,4}$/.test(word),
      ),
  );
}

/**
 * A name from code: camelCase, PascalCase or snake_case made of word-like parts
 * (`isInvoiceRecalculationAvailable`, `isCompactModeEnabledForOrderSelector`, `SAVE_ORDER_SUCCESS`).
 * A secret's mixed case falls apart into one- and two-letter pieces and digits in the middle
 * (`L4vN7bR1tY6wE3zA5cH0jD`). Pilot: long selector names were masked in what the agent read, and it
 * then searched for the placeholder.
 */
export function looksLikeCodeName(s: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s)) return false;
  const words: string[] = [];
  for (const part of s.split(/_+/).filter((p) => p.length > 0)) {
    const pieces = part.match(/[A-Z]{2,}(?=[A-Z][a-z]|[0-9]|$)|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [];
    if (pieces.join("") !== part) return false;
    words.push(...pieces);
  }
  if (words.length === 0) return false;
  const last = words.length - 1;
  const ok = words.every(
    (w, i) =>
      /^[A-Z]?[a-z]+$/.test(w) ||
      /^[A-Z]{2,8}$/.test(w) ||
      (i === last && /^[0-9]{1,4}$/.test(w)) ||
      (i === last - 1 && /^[A-Z]$/.test(w) && /^[0-9]{1,4}$/.test(words[last] ?? "")),
  );
  const letters = words.filter((w) => /[A-Za-z]{2,}/.test(w));
  const mean = letters.reduce((n, w) => n + w.length, 0) / Math.max(1, letters.length);
  const short = letters.filter((w) => w.length <= 2).length;
  return ok && letters.length > 0 && mean >= 3 && short * 2 <= letters.length;
}

/** Hashes, commit shas, UUIDs and paths are identifiers provenance depends on — never redact them. */
function looksLikeIdentifier(s: string): boolean {
  return (
    looksLikePath(s) ||
    looksLikeCodeName(s) ||
    /^[0-9a-f]{32,64}$/i.test(s) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
    /^[0-9]+$/.test(s)
  );
}

export class Redactor {
  private literals: string[];
  private readonly minLiteralLength: number;
  private readonly patterns: readonly RedactionPattern[];
  private readonly salt: string;

  constructor(options: RedactorOptions = {}) {
    const min = options.minLiteralLength ?? 8;
    this.minLiteralLength = min;
    this.literals = [...new Set([...(options.literals ?? [])])]
      .filter((v) => v.length >= min)
      .sort((a, b) => b.length - a.length);
    this.patterns = options.patterns ?? DEFAULT_PATTERNS;
    this.salt = options.salt ?? randomBytes(8).toString("hex");
  }

  /** Secrets resolved after construction (keychain values, ADR-0010 §2) join the literal set. */
  addLiterals(values: Iterable<string>): void {
    this.literals = [...new Set([...this.literals, ...values])]
      .filter((v) => v.length >= this.minLiteralLength)
      .sort((a, b) => b.length - a.length);
  }

  placeholder(type: string, value: string): string {
    const hash = createHash("sha256").update(`${this.salt}\0${value}`).digest("hex").slice(0, 8);
    return `[REDACTED:${type}:${hash}]`;
  }

  redact(text: string): RedactionReport {
    let out = text;
    let count = 0;
    const byType: Record<string, number> = {};
    const samples: RedactionSample[] = [];
    const bump = (type: string) => {
      count += 1;
      byType[type] = (byType[type] ?? 0) + 1;
    };

    for (const literal of this.literals) {
      if (!out.includes(literal)) continue;
      const replacement = this.placeholder("literal", literal);
      out = out.split(literal).join(replacement);
      bump("literal");
    }

    // Patterns never run over placeholders already inserted (a placeholder's own text could
    // match an assignment pattern such as "access-key:…").
    const outside = (text: string, fn: (segment: string) => string): string =>
      text
        .split(/(\[REDACTED:[a-z-]+:[0-9a-f]{8}\])/g)
        .map((part, i) => (i % 2 === 1 ? part : fn(part)))
        .join("");

    for (const pattern of this.patterns) {
      out = outside(out, (segment) =>
        segment.replace(pattern.regex, (match: string, ...groups: unknown[]) => {
          bump(pattern.name);
          // Patterns with a capture group keep the prefix (e.g. "Bearer ", "token=") and redact the rest.
          const prefix = typeof groups[0] === "string" ? groups[0] : "";
          const suffix = typeof groups[1] === "string" && pattern.name === "basic-auth-url" ? groups[1] : "";
          const secret = match.slice(prefix.length, match.length - suffix.length);
          return `${prefix}${this.placeholder(pattern.name, secret)}${suffix}`;
        }),
      );
    }

    out = outside(out, (segment) =>
      segment.replace(HIGH_ENTROPY, (match: string, offset: number, whole: string) => {
        if (looksLikeIdentifier(match)) return match;
        // Only in an assignment-like context: "= value", ": value", "token value".
        const before = whole.slice(Math.max(0, offset - 24), offset);
        if (!/[:=]\s*["']?$|(?:key|token|secret|password)\s*["']?$/i.test(before)) return match;
        if (shannonEntropy(match) < 4.0) return match;
        bump("high-entropy");
        const placeholder = this.placeholder("high-entropy", match);
        if (samples.length < MAX_SAMPLES)
          samples.push({
            placeholder,
            shape: shapeOf(match),
            // long runs before it may be secrets not replaced yet: never quoted
            before: whole
              .slice(Math.max(0, offset - 30), offset)
              .replace(/[A-Za-z0-9+/=_-]{12,}/g, "…")
              .replace(/\s+/g, " ")
              .trimStart(),
          });
        return placeholder;
      }),
    );

    return { text: out, count, byType, ...(samples.length > 0 ? { samples } : {}) };
  }

  /** Redacts every string inside a JSON-like value, keeping its shape. */
  redactValue<T>(value: T): { value: T; count: number } {
    let count = 0;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") {
        const r = this.redact(v);
        count += r.count;
        return r.text;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child);
        return out;
      }
      return v;
    };
    return { value: walk(value) as T, count };
  }
}

/** ADR-0010 §2 (1): values of environment variables whose names look like secrets. */
export function secretLiteralsFromEnv(env: NodeJS.ProcessEnv, extraNames: readonly string[] = []): string[] {
  const names = new Set(extraNames);
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (names.has(name) || looksLikeSecretKey(name)) out.push(value);
  }
  return out;
}

export function compilePatterns(custom: ReadonlyArray<{ name: string; regex: string }>): RedactionPattern[] {
  return [...custom.map((p) => ({ name: p.name, regex: new RegExp(p.regex, "g") })), ...DEFAULT_PATTERNS];
}

/* ------------------------------------------------------------------------------------------------
 * Denied paths (ADR-0010 §2 (2)): reads are refused before they happen, not redacted after.
 * ---------------------------------------------------------------------------------------------- */

export const DEFAULT_DENIED_PATHS: readonly string[] = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/secrets/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/id_ed25519*",
  ".ssh/**",
  ".aws/**",
  ".npmrc",
  "**/.npmrc",
  ".jarvis/credentials*",
];

const REGEX_SPECIALS = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

function globToRegex(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (REGEX_SPECIALS.has(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`${re}$`);
}

export class PathPolicy {
  private readonly rules: RegExp[];
  constructor(globs: readonly string[] = DEFAULT_DENIED_PATHS) {
    this.rules = globs.map(globToRegex);
  }
  /** `relative` is workspace-relative with forward slashes. */
  isDenied(relative: string): boolean {
    const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "");
    return this.rules.some((r) => r.test(normalized));
  }
}
