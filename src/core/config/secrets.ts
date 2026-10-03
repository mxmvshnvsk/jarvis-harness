import { z } from "zod";

/**
 * A reference to a secret value. Secrets never appear literally in configuration
 * (ADR-0014 §1, ADR-0017 §5): only `env:VAR` or `keychain:ID` references are accepted.
 */
export const SECRET_REF_PATTERN = /^(env|keychain):([A-Za-z0-9_.-]+)$/;

export const SecretRefSchema = z
  .string()
  .regex(SECRET_REF_PATTERN, "literal secrets are not allowed; use env:VAR or keychain:ID");

export type SecretRef = `env:${string}` | `keychain:${string}`;

export interface ParsedSecretRef {
  readonly kind: "env" | "keychain";
  readonly name: string;
}

export function parseSecretRef(ref: string): ParsedSecretRef {
  const match = SECRET_REF_PATTERN.exec(ref);
  if (!match) {
    throw new Error(`invalid secret reference "${ref}"; expected env:VAR or keychain:ID`);
  }
  return { kind: match[1] as "env" | "keychain", name: match[2] as string };
}

export function isSecretRef(value: unknown): value is SecretRef {
  return typeof value === "string" && SECRET_REF_PATTERN.test(value);
}

/** Keys whose values are secrets by convention (ADR-0010 §2). */
export const SECRET_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL)/i;

export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Resolves secret references to values. The keychain backend arrives with `jarvis auth`
 * (ADR-0017 §5); until then the env backend is the only one that returns values.
 */
export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string | undefined>;
  /** Whether the backend for this ref is available at all (for `doctor`). */
  supports(ref: SecretRef): boolean;
}

export class EnvSecretResolver implements SecretResolver {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  supports(ref: SecretRef): boolean {
    return parseSecretRef(ref).kind === "env";
  }

  async resolve(ref: SecretRef): Promise<string | undefined> {
    const parsed = parseSecretRef(ref);
    if (parsed.kind !== "env") return undefined;
    const value = this.env[parsed.name];
    return value === undefined || value === "" ? undefined : value;
  }
}

/** Chains resolvers; the first one that supports the ref answers. */
export class CompositeSecretResolver implements SecretResolver {
  private readonly resolvers: readonly SecretResolver[];

  constructor(resolvers: readonly SecretResolver[]) {
    this.resolvers = resolvers;
  }

  supports(ref: SecretRef): boolean {
    return this.resolvers.some((r) => r.supports(ref));
  }

  async resolve(ref: SecretRef): Promise<string | undefined> {
    for (const resolver of this.resolvers) {
      if (resolver.supports(ref)) return resolver.resolve(ref);
    }
    return undefined;
  }
}
