import { Project, type SourceFile, SyntaxKind } from "ts-morph";
import type {
  FileFacts,
  GraphEdge,
  GraphNode,
  ProjectGraphExtractor,
} from "../../core/capabilities/contracts.ts";

/**
 * TypeScript facts extractor (ADR-0008 §1, ADR-0021 §6): a pure function of one file's content.
 * No type checking, no cross-file resolution — import specifiers are left raw for the tree-level
 * resolver. Output is sorted so equal input gives byte-equal facts.
 */
export const TS_EXTRACTOR_VERSION = 1;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function sorted<T extends { id?: string; from?: string; to?: string; relation?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    `${a.id ?? ""}${a.from ?? ""}${a.relation ?? ""}${a.to ?? ""}`.localeCompare(
      `${b.id ?? ""}${b.from ?? ""}${b.relation ?? ""}${b.to ?? ""}`,
    ),
  );
}

function symbolsOf(file: string, sf: SourceFile): GraphNode[] {
  const nodes: GraphNode[] = [];
  const add = (name: string | undefined, kind: GraphNode["kind"], exported: boolean, line: number) => {
    if (!name) return;
    nodes.push({ id: `${file}#${name}`, kind, file, metadata: { exported, line } });
  };
  for (const fn of sf.getFunctions()) add(fn.getName(), "Function", fn.isExported(), fn.getStartLineNumber());
  for (const c of sf.getClasses()) add(c.getName(), "Type", c.isExported(), c.getStartLineNumber());
  for (const i of sf.getInterfaces()) add(i.getName(), "Type", i.isExported(), i.getStartLineNumber());
  for (const t of sf.getTypeAliases()) add(t.getName(), "Type", t.isExported(), t.getStartLineNumber());
  for (const e of sf.getEnums()) add(e.getName(), "Type", e.isExported(), e.getStartLineNumber());
  for (const v of sf.getVariableStatements()) {
    for (const d of v.getDeclarations()) {
      const init = d.getInitializer();
      const isFn =
        init?.getKind() === SyntaxKind.ArrowFunction || init?.getKind() === SyntaxKind.FunctionExpression;
      add(d.getName(), isFn ? "Function" : "Symbol", v.isExported(), d.getStartLineNumber());
    }
  }
  return nodes;
}

export class TypeScriptExtractor implements ProjectGraphExtractor {
  readonly version = TS_EXTRACTOR_VERSION;
  readonly extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"];
  private readonly project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });

  async extract(file: string, content: string): Promise<FileFacts> {
    let sf: SourceFile;
    try {
      sf = this.project.createSourceFile(`/${file}`, content, { overwrite: true });
    } catch (error) {
      return {
        nodes: [{ id: file, kind: "Module", file }],
        edges: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const isTest = TEST_FILE.test(file);
      const nodes: GraphNode[] = [
        { id: file, kind: isTest ? "Test" : "Module", file, metadata: { lines: sf.getEndLineNumber() } },
        ...symbolsOf(file, sf),
      ];
      const edges: GraphEdge[] = [];
      const specifiers = new Set<string>();
      for (const imp of sf.getImportDeclarations()) specifiers.add(imp.getModuleSpecifierValue());
      for (const exp of sf.getExportDeclarations()) {
        const spec = exp.getModuleSpecifierValue();
        if (spec) specifiers.add(spec);
      }
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (expr.getKind() === SyntaxKind.ImportKeyword || expr.getText() === "require") {
          const arg = call.getArguments()[0];
          if (arg?.getKind() === SyntaxKind.StringLiteral) specifiers.add(arg.getText().slice(1, -1));
        }
      }
      for (const spec of specifiers) {
        // `spec:` prefix marks an unresolved specifier; the resolver turns it into a file id (ADR-0008 §1).
        edges.push({ from: file, to: `spec:${spec}`, relation: isTest ? "TESTED_BY" : "DEPENDS_ON" });
      }
      return { nodes: sorted(nodes), edges: sorted(edges) };
    } finally {
      this.project.removeSourceFile(sf);
    }
  }
}
