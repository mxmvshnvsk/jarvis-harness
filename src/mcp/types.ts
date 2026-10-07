import type { Network } from "../core/config/schema.ts";
import type { ToolAccess } from "../tools/types.ts";

/** One tool as the server advertises it (`tools/list`). */
export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Result of `tools/call`, flattened. */
export interface McpCallResult {
  readonly ok: boolean;
  readonly text: string;
  readonly structured?: unknown;
}

/** The slice of an MCP client the provider and the profiles need; the pool implements it. */
export interface McpConnection {
  readonly serverId: string;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/**
 * Profile entry (ADR-0017 §4): how one normalized capability maps onto a server tool. `tools` lists
 * candidate server tool names — the first one the server advertises is used, so the same profile
 * covers servers that name their tools differently.
 */
export interface ProfileCapability {
  readonly tools: readonly string[];
  readonly description: string;
  readonly access: ToolAccess;
  readonly effect: boolean;
  /** JSON Schema of the agent-facing arguments (before `args` rewriting). */
  readonly parameters?: Record<string, unknown>;
  /** Where the effect marker goes — the argument whose text gets the marker appended. */
  readonly markerArg?: string;
  /** Rewrites agent arguments into the server tool's arguments. */
  readonly args?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Looks for the marker on the server side (ADR-0002 §3). */
  readonly verify?: (
    connection: McpConnection,
    resolveTool: (candidates: readonly string[]) => string | undefined,
    args: Record<string, unknown>,
    marker: string,
  ) => Promise<McpCallResult | "not-found" | undefined>;
  /**
   * Reads only: adds to an answer what the server's answer leaves out, by calling the same capability
   * again with other arguments (`again` goes through the same tool and argument mapping).
   */
  readonly enrich?: (
    result: McpCallResult,
    args: Record<string, unknown>,
    again: (args: Record<string, unknown>) => Promise<McpCallResult>,
  ) => Promise<McpCallResult>;
  /** Reads only: answers kept this long and reused for the same arguments (`fresh: true` skips it). */
  readonly cacheMs?: number;
  /** A failed answer that says "not before N seconds" (a 429 with Retry-After): N, else undefined. */
  readonly retryAfterSeconds?: (result: McpCallResult) => number | undefined;
}

export interface McpProfile {
  readonly name: string;
  readonly version: number;
  readonly network: Network;
  readonly map: Readonly<Record<string, ProfileCapability>>;
}

/** Builds a flat object schema: `{ key: description }` plus the required names. */
export function params(
  props: Readonly<Record<string, string>>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(props).map(([k, d]) => [
        k,
        { type: k === "limit" ? "integer" : "string", description: d },
      ]),
    ),
    required: [...required],
    additionalProperties: false,
  };
}
