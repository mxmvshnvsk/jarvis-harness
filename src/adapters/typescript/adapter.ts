import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CodeIntelligence,
  DetectionResult,
  LanguageAdapter,
  LanguageCapability,
  SymbolRef,
} from "../../core/capabilities/contracts.ts";
import type { Snapshot } from "../../knowledge/graph/store.ts";
import { TypeScriptExtractor } from "./extractor.ts";

/**
 * TypeScript / JavaScript adapter (ADR-0021 §2, §8): detection, default commands, the ts-morph
 * extractor and a code-intelligence port answered from the latest graph snapshot. In-process —
 * the first and most mature capability pack.
 */
export class TypeScriptAdapter implements LanguageAdapter {
  readonly id = "typescript";
  readonly languages = ["typescript", "javascript", "node", "react"];
  private readonly extractor = new TypeScriptExtractor();
  private readonly snapshotOf: (workspace: string) => Snapshot | undefined;

  constructor(snapshotOf: (workspace: string) => Snapshot | undefined = () => undefined) {
    this.snapshotOf = snapshotOf;
  }

  async detect(workspacePath: string): Promise<DetectionResult> {
    const evidence: string[] = [];
    const stacks = new Set<string>();
    if (existsSync(join(workspacePath, "tsconfig.json"))) {
      evidence.push("tsconfig.json");
      stacks.add("typescript");
    }
    if (existsSync(join(workspacePath, "package.json"))) {
      evidence.push("package.json");
      stacks.add("node");
      try {
        const pkg = JSON.parse(readFileSync(join(workspacePath, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.typescript) stacks.add("typescript");
        if (deps.react) stacks.add("react");
      } catch {
        // unreadable package.json
      }
    }
    return { detected: evidence.length > 0, stacks: [...stacks].sort(), evidence };
  }

  capabilities(): readonly LanguageCapability[] {
    return ["build", "test", "lint", "codeIntelligence", "graph"];
  }

  defaultCommands(): Partial<Record<"build" | "test" | "format" | "lint", string>> {
    return {};
  }

  graphExtractor(): TypeScriptExtractor {
    return this.extractor;
  }

  codeIntelligence(workspacePath: string): CodeIntelligence {
    const snapshot = () => this.snapshotOf(workspacePath);
    const toRef = (n: {
      id: string;
      kind: string;
      file?: string;
      metadata?: Record<string, unknown>;
    }): SymbolRef => ({
      name: n.id.includes("#") ? (n.id.split("#")[1] as string) : n.id,
      kind:
        n.kind === "Function"
          ? "function"
          : n.kind === "Type"
            ? "type"
            : n.kind === "Test"
              ? "test"
              : n.kind === "Module"
                ? "module"
                : "variable",
      range: {
        file: n.file ?? n.id,
        startLine: Number(n.metadata?.line ?? 1),
        endLine: Number(n.metadata?.line ?? 1),
      },
      handle: n.id,
    });
    return {
      async findSymbol(query) {
        const s = snapshot();
        if (!s) return [];
        return s.nodes
          .filter((n) => n.id.includes("#"))
          .filter(
            (n) => (!query.name || n.id.endsWith(`#${query.name}`)) && (!query.file || n.file === query.file),
          )
          .map(toRef)
          .filter((r) => !query.kind || r.kind === query.kind);
      },
      async findReferences(symbol) {
        const s = snapshot();
        if (!s) return [];
        // Module-level precision: files that import the symbol's file.
        return s.edges
          .filter((e) => e.relation === "DEPENDS_ON" && e.to === symbol.range.file)
          .map((e) => ({
            symbol,
            range: { file: e.from, startLine: 1, endLine: 1 },
            kind: "import" as const,
          }));
      },
      async getDefinition(symbol) {
        const s = snapshot();
        const node = s?.nodes.find((n) => n.id === symbol.handle);
        return node ? { symbol: toRef(node) } : null;
      },
      async getDependencies(target) {
        const s = snapshot();
        if (!s) return [];
        return s.edges
          .filter((e) => e.from === target.file)
          .map((e) => ({ from: e.from, to: e.to, relation: e.relation }));
      },
      async getDiagnostics() {
        return [];
      },
    };
  }
}
