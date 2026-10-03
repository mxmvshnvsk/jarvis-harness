import { z } from "zod";

/** ADR-0006 §1 — who decided; separate from which agent executed. */
export const ActorKindSchema = z.enum(["user", "service", "ci"]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const ActorSchema = z.strictObject({
  kind: ActorKindSchema,
  id: z.string().min(1),
  display: z.string().min(1).optional(),
  /** false — self-asserted (local); true — confirmed by a backend/SSO (shared runtime). */
  verified: z.boolean().default(false),
});
export type Actor = z.infer<typeof ActorSchema>;

export const DAEMON_ACTOR: Actor = {
  kind: "service",
  id: "daemon",
  display: "jarvis daemon",
  verified: false,
};

export function formatActor(actor: Actor): string {
  return `${actor.kind}:${actor.id}`;
}

export function parseActorId(value: string): Actor {
  const match = /^(user|service|ci):(.+)$/.exec(value);
  if (match) {
    return { kind: match[1] as ActorKind, id: match[2] as string, verified: false };
  }
  return { kind: "user", id: value, verified: false };
}
