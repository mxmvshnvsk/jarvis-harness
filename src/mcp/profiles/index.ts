import type { McpServerConfig } from "../../core/config/schema.ts";
import type { McpProfile, ProfileCapability } from "../types.ts";
import { atlassianProfile } from "./atlassian.ts";
import { bitbucketProfile } from "./bitbucket.ts";

export const BUILTIN_PROFILES: ReadonlyMap<string, McpProfile> = new Map(
  [atlassianProfile, bitbucketProfile].map((p) => [p.name, p]),
);

export class UnknownProfileError extends Error {
  constructor(name: string) {
    super(`unknown MCP profile "${name}"; built-in profiles: ${[...BUILTIN_PROFILES.keys()].join(", ")}`);
    this.name = "UnknownProfileError";
  }
}

/**
 * Resolves the profile of a server config (ADR-0017 §4). A config extension
 * (`profile: { base, map }`) may add pure capabilities only: `effect: false`, `access: read`.
 */
export function resolveProfile(
  server: McpServerConfig,
  profiles: ReadonlyMap<string, McpProfile> = BUILTIN_PROFILES,
): McpProfile | undefined {
  const spec = server.profile;
  if (spec === undefined) return undefined;
  if (typeof spec === "string") {
    const profile = profiles.get(spec);
    if (!profile) throw new UnknownProfileError(spec);
    return profile;
  }
  const base = profiles.get(spec.base);
  if (!base) throw new UnknownProfileError(spec.base);
  const extra: Record<string, ProfileCapability> = {};
  for (const [capability, tool] of Object.entries(spec.map)) {
    if (capability in base.map) continue; // config cannot redefine built-in entries
    extra[capability] = {
      tools: [tool],
      description: `${tool} (pure, from project config)`,
      access: "read",
      effect: false,
    };
  }
  return { ...base, map: { ...base.map, ...extra } };
}
