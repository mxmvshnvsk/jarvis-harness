import { homedir } from "node:os";
import type { Output } from "./output.ts";

/** Everything a command needs that is not a flag of its own; injected for tests. */
export interface CliContext {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly out: Output;
  readonly profile?: string;
  /** Where answers come from when a run stops for a person (src/cli/prompt.ts). */
  readonly stdin?: NodeJS.ReadableStream;
}

export function defaultContext(out: Output, overrides: Partial<CliContext> = {}): CliContext {
  const base: CliContext = { cwd: process.cwd(), env: process.env, homeDir: homedir(), out };
  const merged = { ...base, ...overrides };
  if (merged.profile === undefined) {
    const { profile: _p, ...rest } = merged;
    return rest;
  }
  return merged;
}
