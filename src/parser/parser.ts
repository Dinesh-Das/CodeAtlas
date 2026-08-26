import type { GraphEdge, GraphNode, SourceType } from "../graph/types.js";

export interface ParseInput {
  repositoryId: string;
  repositoryRoot: string;
  relativeFilePath: string;
  language: string;
  content: string;
  contentHash: string;
}

export interface Evidence {
  sourceType: SourceType;
  file: string;
  line: number;
  column: number;
}

export interface ParsedFile {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ParseDiagnostic[];
}

export interface UnresolvedReference {
  name: string;
  kind: "import" | "export" | "call" | "extends" | "implements" | "reference";
  evidence: Evidence;
}

export interface ParseDiagnostic {
  message: string;
  severity: "warning" | "error";
  evidence: Evidence;
}

export interface LanguageAdapter {
  readonly language: string;
  readonly version: string;
  parseFile(input: ParseInput): ParsedFile;
}

// Tree-sitter adapters are introduced in Phase 2. The foundation indexer deliberately
// records supported files as `pending_parser` until an evidence-bearing adapter exists.
