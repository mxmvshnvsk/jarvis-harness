import type { McpServerConfig, Network, ResolvedConfig } from "../core/config/schema.ts";
import { capabilityMatches, matchesAny } from "../tools/registry.ts";
import type { Capability, ToolContext, ToolOutput, ToolProvider } from "../tools/types.ts";
import type { McpPool } from "./client/pool.ts";
import { McpResultStore } from "./client/results.ts";
import { BUILTIN_PROFILES, resolveProfile } from "./profiles/index.ts";
import type { McpCallResult, McpProfile, McpToolInfo, ProfileCapability } from "./types.ts";

/** Effective network of a server: explicit config, else the profile default, else internet. */
export function serverNetwork(server: McpServerConfig, profile?: McpProfile | undefined): Network {
  if (server.network) return server.network;
  if (profile) return profile.network;
  if (server.profile) {
    const name = typeof server.profile === "string" ? server.profile : server.profile.base;
    const p = BUILTIN_PROFILES.get(name);
    if (p) return p.network;
  }
  return "internet";
}

export interface ServerReport {
  readonly id: string;
  readonly transport: string;
  readonly target: string;
  readonly network: Network;
  readonly profile?: string;
  readonly readOnly: boolean;
  readonly discovered?: { at: string; count: number };
  /** Capabilities exposed to agents. */
  readonly exposed: string[];
  /** Denied by `deny` or not in a non-empty `allow`. */
  readonly denied: string[];
  /** Profile entries no advertised tool matches (known only after discovery). */
  readonly unmapped: string[];
  /** Server tools without a profile and not allowed (ADR-0017 §6 "discovered, not allowed"). */
  readonly notAllowed: string[];
  readonly auth?: string;
  /** Unknown profile name: the server exposes nothing until the config is fixed. */
  readonly error?: string;
}

interface Planned {
  readonly name: string;
  readonly serverId: string;
  readonly network: Network;
  readonly profileCap: ProfileCapability;
  readonly parameters: Record<string, unknown>;
  readonly verifiable: boolean;
}

/**
 * MCP tool provider (ADR-0017 §3–4, §6): turns configured servers into normalized capabilities.
 * With a profile the capabilities are known without connecting; without one, tools come from the
 * discovery cache as `mcp.<server>.<tool>` — effects by default, pure when `readOnly`.
 */
export class McpToolProvider implements ToolProvider {
  readonly name = "mcp";
  private readonly config: ResolvedConfig;
  private readonly pool: McpPool;

  private readonly results: McpResultStore | undefined;

  constructor(config: ResolvedConfig, pool: McpPool, results?: McpResultStore) {
    this.config = config;
    this.pool = pool;
    this.results = results;
  }

  capabilities(): readonly Capability[] {
    const out: Capability[] = [];
    for (const serverId of this.pool.serverIds()) {
      for (const planned of this.plan(serverId).exposed) out.push(this.capability(planned));
    }
    return out;
  }

  reports(): ServerReport[] {
    return this.pool.serverIds().map((id) => this.plan(id).report);
  }

  report(serverId: string): ServerReport {
    return this.plan(serverId).report;
  }

  private plan(serverId: string): { exposed: Planned[]; report: ServerReport } {
    const server = this.pool.config(serverId) as McpServerConfig;
    let profile: McpProfile | undefined;
    let profileError: string | undefined;
    try {
      profile = resolveProfile(server);
    } catch (error) {
      profileError = error instanceof Error ? error.message : String(error);
    }
    const network = serverNetwork(server, profile);
    const cached = this.pool.cachedTools(serverId);
    const cacheEntry = this.pool.cacheEntry(serverId);
    const byName = new Map((cached ?? []).map((t) => [t.name, t]));
    const exposed: Planned[] = [];
    const denied: string[] = [];
    const unmapped: string[] = [];
    const notAllowed: string[] = [];
    const permitted = (name: string) => {
      if (matchesAny(name, server.deny)) return false;
      if (server.allow.length === 0) return profile !== undefined || server.readOnly;
      return matchesAny(name, server.allow);
    };

    if (profileError) {
      // nothing is exposed; the report carries the error
    } else if (profile) {
      for (const [name, cap] of Object.entries(profile.map)) {
        if (!permitted(name)) {
          denied.push(name);
          continue;
        }
        const tool = cached ? cap.tools.find((t) => byName.has(t)) : undefined;
        if (cached && !tool) {
          unmapped.push(name);
          continue;
        }
        const schema = cap.parameters ?? (tool ? byName.get(tool)?.inputSchema : undefined) ?? OPEN_OBJECT;
        exposed.push({
          name,
          serverId,
          network,
          profileCap: cap,
          parameters: schema,
          verifiable: cap.verify !== undefined,
        });
      }
    } else if (cached) {
      for (const tool of cached) {
        const name = `mcp.${serverId}.${tool.name}`;
        if (!permitted(name)) {
          (matchesAny(name, server.deny) ? denied : notAllowed).push(name);
          continue;
        }
        exposed.push({
          name,
          serverId,
          network,
          profileCap: {
            tools: [tool.name],
            description: tool.description || `${tool.name} on MCP server ${serverId}`,
            access: server.readOnly ? "read" : "write",
            effect: !server.readOnly,
          },
          parameters: tool.inputSchema,
          verifiable: false,
        });
      }
    }

    const report: ServerReport = {
      id: serverId,
      transport: server.transport,
      target: server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url,
      network,
      ...(profile ? { profile: profile.name } : {}),
      readOnly: server.readOnly,
      ...(cacheEntry ? { discovered: { at: cacheEntry.listedAt, count: cacheEntry.tools.length } } : {}),
      exposed: exposed.map((p) => p.name).sort(),
      denied: denied.sort(),
      unmapped: unmapped.sort(),
      notAllowed: notAllowed.sort(),
      ...(profileError ? { error: profileError } : {}),
      ...(server.transport !== "stdio" && server.auth.type !== "none" ? { auth: server.auth.token } : {}),
      ...(server.transport === "stdio"
        ? (() => {
            const refs = Object.values(server.env).filter((v) => /^(env|keychain):/.test(v));
            return refs.length > 0 ? { auth: refs.join(", ") } : {};
          })()
        : {}),
    };
    return { exposed, report };
  }

  /** The server tool a capability resolves to and the arguments it goes out with. */
  private async prepare(
    planned: Planned,
    args: Record<string, unknown>,
    marker?: string,
  ): Promise<{ tool: string; sent: Record<string, unknown> }> {
    const { profileCap: cap, serverId } = planned;
    const tools = this.pool.cachedTools(serverId) ?? (await this.pool.connection(serverId).listTools());
    const tool = cap.tools.find((c) => tools.some((t) => t.name === c));
    if (!tool)
      throw new Error(
        `MCP server "${serverId}" advertises none of ${cap.tools.join(", ")} (run \`jarvis mcp list --refresh\`)`,
      );
    let agentArgs = args;
    if (marker && cap.markerArg) {
      const current = agentArgs[cap.markerArg];
      agentArgs = {
        ...agentArgs,
        [cap.markerArg]: `${current === undefined ? "" : `${String(current)}\n\n`}[${marker}]`,
      };
    }
    const mapped = cap.args ? cap.args(agentArgs) : agentArgs;
    const schema = tools.find((t) => t.name === tool)?.inputSchema;
    return { tool, sent: filterBySchema(mapped, schema) };
  }

  /** A call as it goes out, then what the profile adds to a read's answer (`enrich`). */
  private async callPlanned(
    planned: Planned,
    args: Record<string, unknown>,
    marker?: string,
  ): Promise<{ tool: string; sent: Record<string, unknown>; result: McpCallResult }> {
    const cap = planned.profileCap;
    const serverId = planned.serverId;
    const connection = this.pool.connection(serverId);
    const { tool, sent } = await this.prepare(planned, args, marker);
    const read = !cap.effect && cap.access === "read";
    // a server that said "not before": not asked again until then (its limit is spent, not broken)
    const blocked = read ? this.results?.blockedUntil(serverId) : undefined;
    if (blocked)
      return {
        tool,
        sent,
        result: {
          ok: false,
          text: `rate limit of MCP server "${serverId}": not called before ${blocked.until} (${blocked.reason})`,
        },
      };
    const key = McpResultStore.key([planned.name, sent, args.raw === true || args.raw === "true"]);
    // the server's own answer is kept, not jarvis's reading of it: a better reading (a new parser)
    // applies to what is in the cache without asking the server again
    const kept =
      read && cap.cacheMs && args.fresh !== true && args.fresh !== "true"
        ? this.results?.get(serverId, key, cap.cacheMs)
        : undefined;
    let result = kept ?? (await connection.callTool(tool, sent));
    const wait = !kept && !result.ok ? cap.retryAfterSeconds?.(result) : undefined;
    if (wait && this.results) {
      const reason = (result.text.split("\n")[0] ?? "").slice(0, 200);
      const until = this.results.block(serverId, wait, reason);
      result = { ...result, text: `${result.text}\n[jarvis: no calls to "${serverId}" before ${until}]` };
    }
    if (!kept && read && cap.cacheMs && result.ok) this.results?.put(serverId, key, result);
    if (cap.enrich && read && result.ok) {
      const again = async (other: Record<string, unknown>) => {
        const next = await this.prepare(planned, other);
        return connection.callTool(next.tool, next.sent);
      };
      try {
        result = await cap.enrich(result, args, again);
      } catch {
        // the answer as it came: the addition is a help, not a condition
      }
    }
    return { tool, sent, result };
  }

  /**
   * One read capability called the way an agent's call goes (`jarvis mcp call`): the same server,
   * tool and arguments, without a run. Effects are refused: they belong to runs, with their journal.
   */
  async invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ serverId: string; tool: string; sent: Record<string, unknown>; result: McpCallResult }> {
    for (const serverId of this.pool.serverIds()) {
      const planned = this.plan(serverId).exposed.find((p) => p.name === name);
      if (!planned) continue;
      if (planned.profileCap.effect || planned.profileCap.access !== "read")
        throw new Error(
          `${name} is an effect (${planned.profileCap.access}): only a run calls it, with its journal`,
        );
      return { serverId, ...(await this.callPlanned(planned, args)) };
    }
    const report = this.reports().find((r) => [...r.denied, ...r.unmapped, ...r.notAllowed].includes(name));
    if (report?.denied.includes(name))
      throw new Error(`${name} is denied on MCP server "${report.id}" (its allow / deny)`);
    if (report?.unmapped.includes(name))
      throw new Error(
        `MCP server "${report.id}" has no tool for ${name} (run \`jarvis mcp list --refresh\`)`,
      );
    if (report) throw new Error(`${name} is discovered on "${report.id}" but not allowed (add it to allow)`);
    throw new Error(`no MCP server exposes ${name} — \`jarvis mcp list\` shows what there is`);
  }

  private capability(planned: Planned): Capability {
    const { profileCap: cap, serverId } = planned;
    const resolveTool = (candidates: readonly string[], tools: readonly McpToolInfo[]) =>
      candidates.find((c) => tools.some((t) => t.name === c));
    const connection = this.pool.connection(serverId);
    const toolsOf = async () => this.pool.cachedTools(serverId) ?? (await connection.listTools());

    const call = async (args: Record<string, unknown>, marker?: string): Promise<McpCallResult> =>
      (await this.callPlanned(planned, args, marker)).result;

    const toOutput = (r: McpCallResult): ToolOutput => ({
      ok: r.ok,
      text: r.text,
      ...(r.structured !== undefined ? { data: r.structured } : {}),
      ...(r.ok ? {} : { error: r.text || "tool reported an error" }),
    });

    const capability: Capability = {
      name: planned.name,
      description: cap.description,
      network: planned.network,
      server: serverId,
      access: cap.access,
      effect: cap.effect,
      parameters: planned.parameters,
      handler: async (args: Record<string, unknown>, ctx: ToolContext) =>
        toOutput(await call(args, cap.effect ? ctx.effect?.marker : undefined)),
    };
    if (cap.verify) {
      const verify = cap.verify;
      return {
        ...capability,
        verify: async (args, record, ctx) => {
          const tools = await toolsOf();
          const marker = ctx.effect?.marker ?? `jarvis:run=${ctx.run.id} effect=${record.key.slice(0, 12)}`;
          const result = await verify(connection, (c) => resolveTool(c, tools), args, marker);
          if (result === undefined || result === "not-found") return result;
          return toOutput(result);
        },
      };
    }
    return capability;
  }
}

const OPEN_OBJECT: Record<string, unknown> = { type: "object", additionalProperties: true };

/** Drops keys the tool's schema does not declare, so synonym arguments never reach a strict server. */
export function filterBySchema(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const props = schema?.properties as Record<string, unknown> | undefined;
  if (!props || Object.keys(props).length === 0) {
    return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  }
  return Object.fromEntries(
    Object.entries(args)
      .filter(([k, v]) => v !== undefined && k in props)
      .map(([k, v]) => [k, coerce(v, props[k])]),
  );
}

/** A model often sends "42" where the tool declares a number: convert a numeric string, leave the rest. */
function coerce(value: unknown, prop: unknown): unknown {
  const type = (prop as { type?: unknown } | undefined)?.type;
  if (
    (type === "number" || type === "integer") &&
    typeof value === "string" &&
    /^-?\d+(\.\d+)?$/.test(value.trim())
  ) {
    return Number(value);
  }
  return value;
}

/** Servers whose capabilities an agent capability set may reach (for the `work` preflight, ADR-0017 §6). */
export function serversNeeded(config: ResolvedConfig, patterns: readonly string[]): string[] {
  const needed: string[] = [];
  for (const [id, server] of Object.entries(config.mcp.servers)) {
    const profile = resolveProfile(server);
    const names = profile ? Object.keys(profile.map) : [`mcp.${id}.*`];
    const reachable = names.some((n) =>
      patterns.some((p) => capabilityMatches(n, p) || capabilityMatches(p, n) || p === "*"),
    );
    if (reachable) needed.push(id);
  }
  return needed.sort();
}
