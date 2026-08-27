import Parser from "tree-sitter";
import path from "node:path";
import { createEdgeId, createNodeId } from "../graph/ids.js";
import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  NodeKind,
  SourceType,
} from "../graph/types.js";
import { provenanceForSource } from "../graph/types.js";
import type {
  Evidence,
  ParseDiagnostic,
  ParsedFile,
  ParseInput,
  UnresolvedReference,
} from "./parser.js";

export type SyntaxNode = Parser.SyntaxNode;

export interface SymbolInput {
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  syntaxNode: SyntaxNode;
  parentNodeId: string;
  signature?: string | null;
  visibility?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AddedSymbol {
  id: string;
  node: GraphNode;
  syntaxNode: SyntaxNode;
}

export function createTree(language: unknown, source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser.parse(source);
}

export function evidenceFor(input: ParseInput, node: SyntaxNode): Evidence {
  return {
    sourceType: "ast",
    file: input.relativeFilePath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  };
}

function evidenceMetadata(input: ParseInput, node: SyntaxNode): Record<string, unknown> {
  const evidence = evidenceFor(input, node);
  return {
    evidence: {
      source_type: evidence.sourceType,
      file: evidence.file,
      line: evidence.line,
      column: evidence.column,
    },
  };
}

export function sanitizeSignature(value: string): string {
  let output = "";
  let quote: "\"" | "'" | "`" | null = null;
  let escaped = false;

  for (const character of value) {
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        output += "<literal>";
        quote = null;
      }
      continue;
    }

    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    output += character;
  }

  if (quote !== null) output += "<literal>";
  return output.replace(/\s+/gu, " ").trim();
}

export function declarationSignature(input: ParseInput, node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  const endIndex = body?.startIndex ?? node.endIndex;
  return sanitizeSignature(input.content.slice(node.startIndex, endIndex).replace(/[:{]\s*$/u, ""));
}

export function findParseDiagnostics(input: ParseInput, root: SyntaxNode): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];

  function visit(node: SyntaxNode): void {
    if (node.isError || node.isMissing) {
      diagnostics.push({
        message: node.isMissing ? `Missing ${node.type}` : `Unexpected syntax near ${node.type}`,
        severity: "error",
        evidence: evidenceFor(input, node),
      });
    }
    for (const child of node.children) visit(child);
  }

  if (root.hasError) visit(root);
  return diagnostics;
}

export class ParseGraphBuilder {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  readonly unresolvedReferences: UnresolvedReference[] = [];
  readonly errors: ParseDiagnostic[];
  readonly moduleNodeId: string;
  private readonly symbolsById = new Map<string, AddedSymbol>();
  private readonly edgeIds = new Set<string>();

  constructor(
    readonly input: ParseInput,
    root: SyntaxNode,
  ) {
    const fileNodeId = createNodeId(
      input.repositoryId,
      "file",
      input.relativeFilePath,
      input.relativeFilePath,
    );
    this.moduleNodeId = createNodeId(
      input.repositoryId,
      "module",
      input.relativeFilePath,
      input.relativeFilePath,
    );
    this.nodes.push({
      id: this.moduleNodeId,
      kind: "module",
      name: path.posix.basename(input.relativeFilePath),
      qualifiedName: input.relativeFilePath,
      filePath: input.relativeFilePath,
      language: input.language,
      startLine: root.startPosition.row + 1,
      startColumn: root.startPosition.column,
      endLine: root.endPosition.row + 1,
      endColumn: root.endPosition.column,
      signature: null,
      visibility: null,
      contentHash: input.contentHash,
      sourceType: "ast",
      provenance: "verified",
      confidence: 1,
      metadata: evidenceMetadata(input, root),
    });
    this.addEdge("CONTAINS", fileNodeId, this.moduleNodeId, root);
    this.errors = findParseDiagnostics(input, root);
  }

  addSymbol(symbol: SymbolInput): AddedSymbol {
    const id = createNodeId(
      this.input.repositoryId,
      symbol.kind,
      this.input.relativeFilePath,
      symbol.qualifiedName,
    );
    const existing = this.symbolsById.get(id);
    if (existing !== undefined) return existing;
    const node: GraphNode = {
      id,
      kind: symbol.kind,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      filePath: this.input.relativeFilePath,
      language: this.input.language,
      startLine: symbol.syntaxNode.startPosition.row + 1,
      startColumn: symbol.syntaxNode.startPosition.column,
      endLine: symbol.syntaxNode.endPosition.row + 1,
      endColumn: symbol.syntaxNode.endPosition.column,
      signature: symbol.signature ?? null,
      visibility: symbol.visibility ?? null,
      contentHash: this.input.contentHash,
      sourceType: "ast",
      provenance: "verified",
      confidence: 1,
      metadata: {
        ...evidenceMetadata(this.input, symbol.syntaxNode),
        ...(symbol.metadata ?? {}),
      },
    };
    this.nodes.push(node);
    this.addEdge("CONTAINS", symbol.parentNodeId, id, symbol.syntaxNode);
    const added = { id, node, syntaxNode: symbol.syntaxNode };
    this.symbolsById.set(id, added);
    return added;
  }

  addExport(
    targetNodeId: string,
    syntaxNode: SyntaxNode,
    sourceType: SourceType = "ast",
    confidence = 1,
  ): void {
    this.addEdge(
      "EXPORTS",
      this.moduleNodeId,
      targetNodeId,
      syntaxNode,
      sourceType,
      confidence,
    );
  }

  addReference(
    reference: Omit<
      UnresolvedReference,
      | "evidence"
      | "sourceNodeId"
      | "localName"
      | "importedName"
      | "provenance"
      | "confidence"
      | "metadata"
    > & Partial<Pick<UnresolvedReference, "sourceNodeId" | "localName" | "importedName">>,
    syntaxNode: SyntaxNode,
    options: Partial<
      Pick<UnresolvedReference, "provenance" | "confidence" | "metadata">
    > = {},
  ): void {
    this.unresolvedReferences.push({
      sourceNodeId: this.moduleNodeId,
      localName: null,
      importedName: null,
      provenance: "verified",
      confidence: 1,
      metadata: {},
      ...reference,
      ...options,
      evidence: evidenceFor(this.input, syntaxNode),
    });
  }

  result(): ParsedFile {
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
    };
  }

  private addEdge(
    edgeType: EdgeType,
    sourceNodeId: string,
    targetNodeId: string,
    syntaxNode: SyntaxNode,
    sourceType: SourceType = "ast",
    confidence = 1,
  ): void {
    const line = syntaxNode.startPosition.row + 1;
    const id = createEdgeId(
      this.input.repositoryId,
      edgeType,
      sourceNodeId,
      targetNodeId,
      this.input.relativeFilePath,
      line,
    );
    if (this.edgeIds.has(id)) return;
    this.edgeIds.add(id);
    this.edges.push({
      id,
      sourceNodeId,
      targetNodeId,
      edgeType,
      sourceType,
      provenance: provenanceForSource(sourceType),
      confidence,
      filePath: this.input.relativeFilePath,
      line,
      metadata: {
        ...evidenceMetadata(this.input, syntaxNode),
      },
    });
  }
}
