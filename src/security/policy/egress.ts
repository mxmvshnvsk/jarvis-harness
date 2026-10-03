import type { DataClass, Egress, Network, ResolvedConfig } from "../../core/config/schema.ts";
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
