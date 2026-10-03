import type { Capability, ToolProvider } from "./types.ts";

/** Glob over capability names: `jira.*`, `*.comment`, `repo.read`. */
export function capabilityMatches(name: string, pattern: string): boolean {
  if (pattern === "*" || pattern === name) return true;
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^\\s]*")}$`,
  );
  return re.test(name);
}

export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => capabilityMatches(name, p));
}

export class ToolRegistry {
  private readonly capabilities = new Map<string, { capability: Capability; provider: string }>();

  register(provider: ToolProvider): void {
    for (const capability of provider.capabilities()) {
      const existing = this.capabilities.get(capability.name);
      if (existing && existing.provider !== provider.name) {
        throw new Error(
          `capability "${capability.name}" is provided by both "${existing.provider}" and "${provider.name}"`,
        );
      }
      this.capabilities.set(capability.name, { capability, provider: provider.name });
    }
  }

  /** Drops every capability of a provider (used when MCP discovery refreshes). */
  unregister(providerName: string): void {
    for (const [name, entry] of this.capabilities) {
      if (entry.provider === providerName) this.capabilities.delete(name);
    }
  }

  replace(provider: ToolProvider): void {
    this.unregister(provider.name);
    this.register(provider);
  }

  get(name: string): Capability | undefined {
    return this.capabilities.get(name)?.capability;
  }

  providerOf(name: string): string | undefined {
    return this.capabilities.get(name)?.provider;
  }

  list(): Capability[] {
    return [...this.capabilities.values()]
      .map((e) => e.capability)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
