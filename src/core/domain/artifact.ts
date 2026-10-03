import { z } from "zod";
import { ActorSchema } from "./actor.ts";

/** ADR-0005 §2 */
export const ProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    agentId: z.string().min(1),
    modelCallRefs: z.array(z.string()).default([]),
    toolCallRefs: z.array(z.string()).default([]),
  }),
  z.strictObject({
    kind: z.literal("tool"),
    capability: z.string().min(1),
    toolCallRef: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("human"),
    actor: ActorSchema,
    diffRef: z.string().min(1).optional(),
    comment: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("import"),
    source: z.string().min(1),
    externalId: z.string().min(1),
    externalVersion: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("compaction"),
    parentRefs: z.array(z.string().min(1)).min(1),
    policy: z.string().min(1).optional(),
  }),
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** ADR-0005 §1 — one immutable version of a logical artifact. */
export const ArtifactVersionSchema = z.strictObject({
  artifactId: z.string().min(1),
  version: z.int().positive(),
  runId: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  schemaVersion: z.int().positive().default(1),
  /** sha256 of the content; the blob is content-addressed by it. */
  contentRef: z.string().regex(/^[0-9a-f]{64}$/),
  parentVersion: z.int().positive().optional(),
  provenance: ProvenanceSchema,
  sourceRefs: z.array(z.string()).default([]),
  stepId: z.string().min(1).optional(),
  iteration: z.int().positive().optional(),
  createdAt: z.iso.datetime(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export function artifactRef(a: Pick<ArtifactVersion, "artifactId" | "version">): string {
  return `${a.artifactId}@${a.version}`;
}

/** ADR-0005 §4 */
export const ApprovalDecisionSchema = z.enum(["approve", "reject", "request_changes"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
