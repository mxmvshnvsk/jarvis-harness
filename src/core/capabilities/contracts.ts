/**
 * Stack-neutral capability contracts (ADR-0021 §2). The core depends on these ports only;
 * adapters (`src/adapters/<stack>`) implement them — in-process or over stdio/MCP — and never
 * leak framework types into core artifacts.
 */
export interface Range {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export type SymbolKind =
  | "module"
  | "class"
  | "interface"
  | "function"
  | "method"
  | "type"
  | "variable"
  | "endpoint"
  | "test";

export interface SymbolRef {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly range: Range;
  /** Adapter-specific handle; opaque to the core. */
  readonly handle?: string;
}

export interface SymbolQuery {
  readonly name?: string;
  readonly kind?: SymbolKind;
  readonly file?: string;
}

export interface Reference {
  readonly symbol: SymbolRef;
  readonly range: Range;
  readonly kind: "call" | "import" | "read" | "write" | "implements" | "extends";
}

export interface DefinitionRef {
  readonly symbol: SymbolRef;
}

export interface Dependency {
  readonly from: string;
  readonly to: string;
  readonly relation:
    | "DEPENDS_ON"
    | "CALLS"
    | "REFERENCES"
    | "IMPLEMENTS"
    | "EXPOSES"
    | "PERSISTS"
    | "EMITS"
    | "TESTED_BY";
}

export interface CodeRef {
  readonly file: string;
  readonly symbol?: SymbolRef;
}

export interface CodeScope {
  readonly files?: readonly string[];
}

export interface Diagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly range?: Range;
  readonly code?: string;
  readonly source: string;
}

export interface CodeIntelligence {
  findSymbol(query: SymbolQuery): Promise<SymbolRef[]>;
  findReferences(symbol: SymbolRef): Promise<Reference[]>;
  getDefinition(symbol: SymbolRef): Promise<DefinitionRef | null>;
  getDependencies(target: CodeRef): Promise<Dependency[]>;
  getDiagnostics(scope: CodeScope): Promise<Diagnostic[]>;
}

export interface DiagnosticsProvider {
  collect(scope: CodeScope): Promise<Diagnostic[]>;
}

export interface GraphNode {
  readonly id: string;
  readonly kind:
    | "Module"
    | "Symbol"
    | "Type"
    | "Function"
    | "Endpoint"
    | "DataModel"
    | "Test"
    | "Event"
    | "Artifact";
  readonly file?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: Dependency["relation"];
}

/** Facts of one file — a pure function of its content and the extractor version (ADR-0008 §1). */
export interface FileFacts {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly error?: string;
}

export interface ProjectGraphExtractor {
  readonly version: number;
  readonly extensions: readonly string[];
  extract(file: string, content: string): Promise<FileFacts>;
}

export interface DetectionResult {
  readonly detected: boolean;
  readonly stacks: readonly string[];
  readonly evidence: readonly string[];
}

/** build | test | format | lint | codeIntelligence | diagnostics | graph */
export type LanguageCapability =
  | "build"
  | "test"
  | "format"
  | "lint"
  | "codeIntelligence"
  | "diagnostics"
  | "graph";

export interface LanguageAdapter {
  readonly id: string;
  readonly languages: readonly string[];
  detect(workspacePath: string): Promise<DetectionResult>;
  capabilities(): readonly LanguageCapability[];
  /** Default project commands when the project config does not name them. */
  defaultCommands?(): Partial<Record<"build" | "test" | "format" | "lint", string>>;
  codeIntelligence?(workspacePath: string): CodeIntelligence;
  diagnostics?(workspacePath: string): DiagnosticsProvider;
  graphExtractor?(): ProjectGraphExtractor;
}
