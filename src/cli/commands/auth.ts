import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { createKeychain, keychainActor } from "../../app/runtime.ts";
import { isSecretRef, parseSecretRef } from "../../core/config/secrets.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";

/** Every `keychain:ID` / `env:VAR` the configuration refers to, with where it is used. */
export function secretRefsOf(config: unknown): Array<{ ref: string; where: string }> {
  const out: Array<{ ref: string; where: string }> = [];
  const visit = (value: unknown, path: string) => {
    if (isSecretRef(value)) out.push({ ref: value, where: path });
    else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        visit(v, `${path}[${i}]`);
      });
    } else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        visit(v, path ? `${path}.${k}` : k);
  };
  visit(config, "");
  return out;
}

async function readSecret(prompt: string, stdin: NodeJS.ReadableStream): Promise<string> {
  const tty = (stdin as NodeJS.ReadStream).isTTY === true;
  if (!tty) {
    // piped: the whole of stdin is the value (first line)
    let data = "";
    for await (const chunk of stdin) data += String(chunk);
    return data.replace(/\r?\n$/, "");
  }
  // the question on stderr as a plain prompt (pilot: printed as `error:`), the typed value not echoed
  let typing = false;
  const muted = new Writable({
    write: (chunk, _e, cb) => {
      if (!typing) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: stdin, output: muted, terminal: true });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
    typing = true;
  });
}

/** `jarvis auth set <id>` — stores a credential in the OS keychain under the actor (ADR-0017 §5). */
export async function runAuthSet(
  ctx: CliContext,
  id: string,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const keychain = createKeychain(loaded, ctx.env);
  const value = await readSecret(`value for keychain:${id} (input hidden): `, stdin);
  if (value.length === 0) {
    ctx.out.error("empty value; nothing stored");
    throw new CliExit(EXIT.error);
  }
  await keychain.set(id, value);
  const actor = keychainActor(loaded, ctx.env);
  ctx.out.result({ id, actor, backend: keychain.backend.kind, stored: true }, () =>
    ctx.out.line(`stored keychain:${id} for ${actor} (${keychain.backend.kind})`),
  );
}

export async function runAuthRemove(ctx: CliContext, id: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const keychain = createKeychain(loaded, ctx.env);
  const removed = await keychain.remove(id);
  ctx.out.result({ id, removed }, () =>
    ctx.out.line(removed ? `removed keychain:${id}` : `keychain:${id} was not set`),
  );
  if (!removed) throw new CliExit(EXIT.error);
}

export interface AuthStatusRow {
  readonly ref: string;
  readonly kind: "env" | "keychain";
  readonly set: boolean;
  readonly usedBy: string[];
}

export async function authStatus(
  ctx: CliContext,
): Promise<{ rows: AuthStatusRow[]; backend: string; actor: string }> {
  const loaded = await loadForCli(ctx);
  const keychain = createKeychain(loaded, ctx.env);
  const byRef = new Map<string, string[]>();
  for (const { ref, where } of secretRefsOf(loaded.config)) {
    byRef.set(ref, [...(byRef.get(ref) ?? []), where]);
  }
  const rows: AuthStatusRow[] = [];
  for (const [ref, usedBy] of [...byRef.entries()].sort()) {
    const parsed = parseSecretRef(ref);
    const set =
      parsed.kind === "env"
        ? (ctx.env[parsed.name] ?? "") !== ""
        : (await keychain.get(parsed.name)) !== undefined;
    rows.push({ ref, kind: parsed.kind, set, usedBy });
  }
  return { rows, backend: keychain.backend.kind, actor: keychainActor(loaded, ctx.env) };
}

/** `jarvis auth status` — presence of every referenced credential, never the values. */
export async function runAuthStatus(ctx: CliContext): Promise<void> {
  const status = await authStatus(ctx);
  ctx.out.result(status, () => {
    ctx.out.line(`keychain backend: ${status.backend}; actor: ${status.actor}`);
    if (status.rows.length === 0) {
      ctx.out.line("no credentials referenced in the configuration");
      return;
    }
    const w = Math.max(...status.rows.map((r) => r.ref.length), 3);
    for (const r of status.rows) {
      ctx.out.line(`${padEnd(r.ref, w)}  ${r.set ? "set    " : "MISSING"}  ${r.usedBy.join(", ")}`);
    }
  });
}
