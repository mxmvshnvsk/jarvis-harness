/**
 * Stack-neutral capability contracts (ADR-0021 §2). The core depends on these ports only;
 * adapters (`src/adapters/<stack>`) implement them — in-process or over stdio/MCP — and never
 * leak framework types into core artifacts.
 */
export interface Range {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startColumn?: number;
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
    | "EXTENDS"
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

/**
 * Resolves a stack's import specifiers across the tree; undefined leaves the core's default, null
 * drops the edge (a candidate the tree does not have — a name that may or may not be a class of it).
 */
export interface SpecifierResolver {
  resolve(from: string, spec: string): string | null | undefined;
}

export interface ProjectGraphExtractor {
  readonly version: number;
  readonly extensions: readonly string[];
  extract(file: string, content: string): Promise<FileFacts>;
  /**
   * Tree-level resolution the per-file facts cannot do (aliases, workspace packages, the members of a
   * class another file declares); part of the snapshot key. `nodes`: every node of the tree's facts.
   */
  readonly resolverVersion?: number;
  createResolver?(
    workspace: string,
    files: ReadonlySet<string>,
    nodes?: readonly GraphNode[],
  ): SpecifierResolver;
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

/* ---- Why tests failed (src/orchestration/tools/testReport.ts) ---- */

export interface StackFrame {
  /** As the runner wrote it: a file (`src/a.ts`, `OrderService.java`) or a class (`a.b.OrderService`). */
  readonly file: string;
  readonly line?: number;
  readonly fn?: string;
  /** The frame's line as printed. */
  readonly raw: string;
}

export interface TestFailure {
  /** The suite or test class. */
  readonly suite?: string;
  readonly name: string;
  /** The test's file, when the report names it. */
  readonly file?: string;
  /** The first lines of the failure: the assertion or the error. */
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly stack: readonly StackFrame[];
}

export interface TestReport {
  readonly source: "junit" | "json" | "text";
  readonly failures: readonly TestFailure[];
  /** Tests run, when the report says. */
  readonly total?: number;
}

/**
 * A test runner of an adapter's stack: how a failed run of it says why — the arguments that make it
 * write a report, and the failures read from the report or from what it printed.
 */
export interface TestReporter {
  /** The runner a test command ends in, and whether arguments reach it only after `--`. */
  runnerOf(
    command: string,
    workspace: string,
  ): { readonly runner: string; readonly dashDash: boolean } | undefined;
  /** The runner's arguments that write its report to `file`, besides its usual output. */
  reporterArgs(runner: string, file: string): string;
  /** An option the runner does not know: the command runs once more as configured. */
  readonly unknownOption: RegExp;
  /**
   * How the runner runs only the tests of a change: given the changed source files (it finds their
   * tests itself) or the test files that cover them (from the project graph), as one quoted list.
   * Undefined: it cannot.
   */
  selection?(runner: string): { readonly by: "changed" | "tests"; args(files: string): string } | undefined;
  /** The failures: from the report when it was written, else from the printed output. */
  failures(
    runner: string,
    file: string | undefined,
    output: string,
    workspace: string,
  ): TestReport | undefined;
}

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
  /** The test runners of the stack: why a failed run failed. */
  testReporter?(): TestReporter;
}
