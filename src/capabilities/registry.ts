import type { LanguageAdapter, LanguageCapability } from "../core/capabilities/contracts.ts";
import type { ResolvedConfig } from "../core/config/schema.ts";
import { detectStackScopes, detectStacks } from "./detector.ts";

/**
 * Capability registry and the ProjectCapabilities artifact (ADR-0021 §3, §7). Adapters register
 * here; the level says how much the run can trust its tooling, and it is never hidden.
 */
export type CapabilityLevel = "FULL" | "BASIC" | "UNSUPPORTED";

export interface ProjectCapabilities {
  readonly stacks: string[];
  readonly detected: string[];
  readonly configured: string[];
  /** ADR-0021 §9: path scope → stacks when the repository holds several. */
  readonly scopes: Record<string, string[]>;
  readonly adapters: Array<{ id: string; capabilities: LanguageCapability[]; evidence: string[] }>;
  readonly commands: Record<string, string>;
  readonly capabilities: Record<string, "adapter" | "project" | "missing">;
  readonly level: CapabilityLevel;
  readonly reasons: string[];
}

export class CapabilityRegistry {
  private readonly adapters: LanguageAdapter[] = [];

  register(adapter: LanguageAdapter): void {
    if (!this.adapters.some((a) => a.id === adapter.id)) this.adapters.push(adapter);
  }

  list(): readonly LanguageAdapter[] {
    return this.adapters;
  }

  async discover(config: ResolvedConfig, workspacePath: string): Promise<ProjectCapabilities> {
    const detected = detectStacks(workspacePath);
    const configured = [...config.stack];
    const scopes = detectStackScopes(workspacePath, config.stackScopes);
    const scoped = [...new Set(Object.values(scopes).flat())].sort();
    const stacks = configured.length > 0 ? configured : detected.length > 0 ? detected : scoped;
    const adapters: ProjectCapabilities["adapters"] = [];
    const commands: Record<string, string> = { ...config.tools.local };
    const caps: ProjectCapabilities["capabilities"] = {};
    const reasons: string[] = [];
    for (const adapter of this.adapters) {
      const result = await adapter.detect(workspacePath);
      if (!result.detected && !adapter.languages.some((l) => stacks.includes(l))) continue;
      adapters.push({
        id: adapter.id,
        capabilities: [...adapter.capabilities()],
        evidence: [...result.evidence],
      });
      for (const [name, command] of Object.entries(adapter.defaultCommands?.() ?? {})) {
        if (command && !commands[name]) commands[name] = command;
      }
    }
    for (const name of ["build", "test", "format", "lint"] as const) {
      caps[name] = config.tools.local[name] ? "project" : commands[name] ? "adapter" : "missing";
    }
    for (const name of ["codeIntelligence", "diagnostics", "graph"] as const) {
      caps[name] = adapters.some((a) => a.capabilities.includes(name)) ? "adapter" : "missing";
    }
    if (configured.length > 0 && detected.length > 0 && !configured.some((s) => detected.includes(s))) {
      reasons.push(
        `configured stack [${configured.join(", ")}] disagrees with detection [${detected.join(", ")}]`,
      );
    }
    let level: CapabilityLevel;
    if (Object.keys(commands).length === 0) {
      level = "UNSUPPORTED";
      reasons.push("no project command at all: declare tools.local.test / build (ADR-0021 §7)");
    } else if (caps.codeIntelligence === "adapter" && caps.graph === "adapter") {
      level = "FULL";
    } else {
      level = "BASIC";
      reasons.push(
        "no language adapter with code intelligence: repo search, commands and model reading only",
      );
    }
    return { stacks, detected, configured, scopes, adapters, commands, capabilities: caps, level, reasons };
  }
}
