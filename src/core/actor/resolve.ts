import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedConfig } from "../config/schema.ts";
import { type Actor, parseActorId } from "../domain/actor.ts";

const execFileAsync = promisify(execFile);

export interface ActorResolution {
  readonly actor?: Actor;
  readonly source?: "env:JARVIS_ACTOR" | "config:actor.id" | "git:user.email";
}

/**
 * ADR-0006 §3: `JARVIS_ACTOR` → `actor.id` in configuration → `git config user.email` of the project.
 * Everything resolved here is self-asserted (`verified: false`).
 */
export async function resolveActor(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv,
  projectRoot: string | undefined,
): Promise<ActorResolution> {
  if (env.JARVIS_ACTOR) {
    return { actor: withKind(parseActorId(env.JARVIS_ACTOR), env), source: "env:JARVIS_ACTOR" };
  }
  if (config.actor.id) {
    const actor = parseActorId(config.actor.id);
    return {
      actor: config.actor.display ? { ...actor, display: config.actor.display } : actor,
      source: "config:actor.id",
    };
  }
  if (projectRoot) {
    try {
      const { stdout } = await execFileAsync("git", ["config", "user.email"], { cwd: projectRoot });
      const email = stdout.trim();
      if (email) return { actor: { kind: "user", id: email, verified: false }, source: "git:user.email" };
    } catch {
      // git missing or no user.email — fall through
    }
  }
  return {};
}

function withKind(actor: Actor, env: NodeJS.ProcessEnv): Actor {
  if (actor.kind === "user" && env.CI && !env.JARVIS_ACTOR?.includes(":")) {
    return { ...actor, kind: "ci" };
  }
  return actor;
}
