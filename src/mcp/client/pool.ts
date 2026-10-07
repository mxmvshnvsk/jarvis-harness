import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, ModelAuth } from "../../core/config/schema.ts";
import { isSecretRef, type SecretRef, type SecretResolver } from "../../core/config/secrets.ts";
import type { McpCallResult, McpConnection, McpToolInfo } from "../types.ts";

/**
 * MCP client pool (ADR-0017 §6): one lazily opened client per server and process, `tools/list`
 * cached on disk so capabilities are known before any connection is made, credentials injected
 * only at the transport (§5).
 */
export interface ToolsCacheEntry {
  readonly serverId: string;
  readonly listedAt: string;
  readonly hash: string;
  readonly tools: readonly McpToolInfo[];
}

export class ToolsCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(serverId: string): string {
    return join(this.dir, `${serverId}.json`);
  }

  get(serverId: string): ToolsCacheEntry | undefined {
    const file = this.file(serverId);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as ToolsCacheEntry;
    } catch {
      return undefined;
    }
  }

  put(serverId: string, tools: readonly McpToolInfo[]): ToolsCacheEntry {
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const hash = createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
    const entry: ToolsCacheEntry = { serverId, listedAt: new Date().toISOString(), hash, tools: sorted };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(serverId), `${JSON.stringify(entry, null, 2)}\n`);
    return entry;
  }
}

export class McpAuthError extends Error {
  constructor(serverId: string, ref: string) {
    super(
      `MCP server "${serverId}": credential ${ref} is not set (run \`jarvis auth set\` or export the variable)`,
    );
    this.name = "McpAuthError";
  }
}

async function authHeaders(
  serverId: string,
  auth: ModelAuth,
  secrets: SecretResolver,
): Promise<Record<string, string>> {
  if (auth.type === "none") return {};
  const value = await secrets.resolve(auth.token as SecretRef);
  if (value === undefined) throw new McpAuthError(serverId, auth.token);
  return auth.type === "bearer" ? { authorization: `Bearer ${value}` } : { [auth.header]: value };
}

export async function resolveEnv(
  serverId: string,
  env: Readonly<Record<string, string>>,
  secrets: SecretResolver,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isSecretRef(value)) {
      const resolved = await secrets.resolve(value);
      if (resolved === undefined) throw new McpAuthError(serverId, value);
      out[key] = resolved;
    } else out[key] = value;
  }
  return out;
}

/** Anything `Client.connect` accepts; the SDK's own transports under exactOptionalPropertyTypes. */
export type ClientTransport = Parameters<Client["connect"]>[0];

export type TransportFactory = (
  serverId: string,
  config: McpServerConfig,
  secrets: SecretResolver,
  baseEnv: NodeJS.ProcessEnv,
) => Promise<ClientTransport>;

export const defaultTransportFactory: TransportFactory = async (serverId, config, secrets, baseEnv) => {
  if (config.transport === "stdio") {
    const inherited: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "LANG", "SystemRoot"]) {
      const v = baseEnv[key];
      if (v !== undefined) inherited[key] = v;
    }
    return new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: { ...inherited, ...(await resolveEnv(serverId, config.env, secrets)) },
      stderr: "ignore",
      ...(config.cwd ? { cwd: config.cwd } : {}),
    }) as unknown as ClientTransport;
  }
  const headers = await authHeaders(serverId, config.auth, secrets);
  if (config.transport === "http")
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
    }) as unknown as ClientTransport;
  return new SSEClientTransport(new URL(config.url), {
    requestInit: { headers },
  }) as unknown as ClientTransport;
};

interface Entry {
  readonly client: Client;
  readonly tools: McpToolInfo[];
}

export interface PoolOptions {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  readonly secrets: SecretResolver;
  readonly cache: ToolsCache;
  readonly env?: NodeJS.ProcessEnv;
  readonly transportFactory?: TransportFactory;
  readonly clientVersion?: string;
}

export class McpPool {
  private readonly options: PoolOptions;
  private readonly entries = new Map<string, Promise<Entry>>();

  constructor(options: PoolOptions) {
    this.options = options;
  }

  serverIds(): string[] {
    return Object.keys(this.options.servers).sort();
  }

  config(serverId: string): McpServerConfig | undefined {
    return this.options.servers[serverId];
  }

  /** Tools as last listed — from disk without connecting, or from the live client if open. */
  cachedTools(serverId: string): readonly McpToolInfo[] | undefined {
    return this.options.cache.get(serverId)?.tools;
  }

  cacheEntry(serverId: string): ToolsCacheEntry | undefined {
    return this.options.cache.get(serverId);
  }

  connection(serverId: string): McpConnection {
    return {
      serverId,
      listTools: async () => [...(await this.entry(serverId)).tools],
      callTool: (name, args) => this.call(serverId, name, args),
    };
  }

  /** Connects (if needed), lists tools, refreshes the cache. */
  async discover(serverId: string): Promise<ToolsCacheEntry> {
    const entry = await this.entry(serverId);
    return this.options.cache.put(serverId, entry.tools);
  }

  /**
   * Is the server up right now: a connection of its own (not the pool's, which may be stale), the
   * tool list, the cache refreshed, the connection closed. For the `mcp` indicator of `jarvis ui`.
   */
  async probe(serverId: string, timeoutMs = 60_000): Promise<{ entry: ToolsCacheEntry; ms: number }> {
    const config = this.options.servers[serverId];
    if (!config) throw new Error(`unknown MCP server "${serverId}"`);
    const started = Date.now();
    const opening = this.open(serverId, config);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      const opened = await Promise.race([opening, timeout]);
      try {
        return { entry: this.options.cache.put(serverId, opened.tools), ms: Date.now() - started };
      } finally {
        await opened.client.close().catch(() => {});
      }
    } catch (error) {
      // a server that answers after the timeout is closed then
      opening.then((late) => late.client.close()).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async call(serverId: string, name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const entry = await this.entry(serverId);
    const result = await entry.client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
      .join("\n")
      .trim();
    const structured = result.structuredContent;
    return {
      ok: result.isError !== true,
      text: text.length > 0 || structured === undefined ? text : JSON.stringify(structured),
      ...(structured !== undefined ? { structured } : {}),
    };
  }

  private entry(serverId: string): Promise<Entry> {
    const config = this.options.servers[serverId];
    if (!config) return Promise.reject(new Error(`unknown MCP server "${serverId}"`));
    let pending = this.entries.get(serverId);
    if (!pending) {
      pending = this.open(serverId, config).catch((error) => {
        this.entries.delete(serverId);
        throw error;
      });
      this.entries.set(serverId, pending);
    }
    return pending;
  }

  private async open(serverId: string, config: McpServerConfig): Promise<Entry> {
    const factory = this.options.transportFactory ?? defaultTransportFactory;
    const transport = await factory(serverId, config, this.options.secrets, this.options.env ?? process.env);
    const client = new Client({ name: "jarvis", version: this.options.clientVersion ?? "0.0.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools: McpToolInfo[] = listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
    }));
    return { client, tools };
  }

  async close(): Promise<void> {
    const open = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      open.map(async (p) => {
        try {
          const e = await p;
          await e.client.close();
        } catch {
          // closing a failed connection is not an error
        }
      }),
    );
  }
}
