import type {
  DataClass,
  Egress,
  EgressException,
  Network,
  ResolvedConfig,
} from "../../core/config/schema.ts";
import { serverNetwork } from "../../mcp/provider.ts";

/**
 * ADR-0016 §2 — the deterministic egress rule.
 *
 * | dataClass    | models           | tools                              |
 * | confidential | egress: private  | network: none | intranet           |
 * | internal     | egress: private  | none | intranet | internet (untrusted, ADR-0016 §4) |
 * | public       | any              | any                                |
 */
export function modelAllowed(dataClass: DataClass, egress: Egress): boolean {
  return dataClass === "public" || egress === "private";
}

export function networkAllowed(dataClass: DataClass, network: Network): boolean {
  if (network === "internet") return dataClass !== "confidential";
  return true;
}

export interface EgressDecision {
  readonly id: string;
  readonly allowed: boolean;
  readonly reason?: string;
  /** Out of its data class's network by the project's exception (ADR-0016 §6): reads only. */
  readonly exception?: string;
}

const matches = (name: string, patterns: readonly string[]) =>
  patterns.some((p) => p === "*" || p === name || (p.endsWith(".*") && name.startsWith(p.slice(0, -1))));

/**
 * The project's exception that lets this capability out of the network its data class allows: an MCP
 * server named in `egressExceptions`, a read (never an effect), a capability its patterns match.
 */
export function egressExceptionFor(
  config: Pick<ResolvedConfig, "dataClass" | "egressExceptions">,
  capability: { name: string; server?: string; network: Network; access: string; effect: boolean },
): EgressException | undefined {
  if (networkAllowed(config.dataClass, capability.network)) return undefined;
  if (!capability.server || capability.access !== "read" || capability.effect) return undefined;
  return config.egressExceptions.find(
    (e) => e.server === capability.server && matches(capability.name, e.capabilities),
  );
}

export interface EgressNotice {
  readonly server: string;
  readonly network: Network;
  readonly dataClass: DataClass;
  readonly reason: string;
}

/**
 * What every run says at its start and the page shows (ADR-0016 §6): the servers that go out of the
 * project's data class by an exception. Empty when the data class allows their network anyway.
 */
export function egressNotices(config: ResolvedConfig): EgressNotice[] {
  return config.egressExceptions.flatMap((e) => {
    const server = config.mcp.servers[e.server];
    if (!server) return [];
    const network = serverNetwork(server);
    return networkAllowed(config.dataClass, network)
      ? []
      : [{ server: e.server, network, dataClass: config.dataClass, reason: e.reason }];
  });
}

/** `⚠ dataClass confidential — MCP server "figma" goes to the internet (reads only): …` */
export function formatEgressNotice(n: EgressNotice): string {
  return `dataClass ${n.dataClass} — MCP server "${n.server}" goes to the ${n.network} by an exception (reads only): ${n.reason}`;
}

export interface EgressSummary {
  readonly dataClass: DataClass;
  readonly models: readonly EgressDecision[];
  readonly servers: readonly EgressDecision[];
  readonly telemetryExport: EgressDecision;
}

export function evaluateEgress(config: ResolvedConfig): EgressSummary {
  const dataClass = config.dataClass;
  const models = Object.entries(config.models).map(([id, model]): EgressDecision => {
    const allowed = modelAllowed(dataClass, model.egress);
    return allowed
      ? { id, allowed }
      : { id, allowed, reason: `egress: ${model.egress} is not allowed for dataClass ${dataClass}` };
  });
  const servers = Object.entries(config.mcp.servers).map(([id, server]): EgressDecision => {
    const network = serverNetwork(server);
    const allowed = networkAllowed(dataClass, network);
    const exception = config.egressExceptions.find((e) => e.server === id);
    if (!allowed && exception) return { id, allowed: true, exception: exception.reason };
    return allowed
      ? { id, allowed }
      : { id, allowed, reason: `network: ${network} is not allowed for dataClass ${dataClass}` };
  });
  const exp = config.telemetry.export;
  const exportAllowed = !exp.enabled || networkAllowed(dataClass, exp.network);
  const telemetryExport: EgressDecision = exportAllowed
    ? { id: "telemetry.export", allowed: true }
    : {
        id: "telemetry.export",
        allowed: false,
        reason: `telemetry export over ${exp.network} is not allowed for dataClass ${dataClass}`,
      };
  return { dataClass, models, servers, telemetryExport };
}

export function formatEgressLine(summary: EgressSummary): string {
  const modelsAllowed = summary.models.filter((m) => m.allowed).length;
  const serversAllowed = summary.servers.filter((s) => s.allowed).length;
  const modelsRule = summary.dataClass === "public" ? "any" : "private only";
  const toolsRule =
    summary.dataClass === "confidential" ? "none|intranet" : "none|intranet|internet(untrusted)";
  return (
    `egress: dataClass=${summary.dataClass}; ` +
    `models=${modelsRule} (${modelsAllowed} of ${summary.models.length} allowed); ` +
    `tools=${toolsRule} (${serversAllowed} of ${summary.servers.length} servers allowed); ` +
    `telemetry export=${summary.telemetryExport.allowed ? "ok" : "denied"}`
  );
}
