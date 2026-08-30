import type {
  GraphEdge,
  GraphNode,
  ProvenanceCategory,
  SourceType,
} from "../graph/types.js";
import type { SyntaxNode } from "./tree-sitter.js";

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
  kind:
    | "import"
    | "export"
    | "call"
    | "extends"
    | "implements"
    | "reference"
    | "callback"
    | "event_subscribe"
    | "event_publish"
    | "queue_subscribe"
    | "queue_publish"
    | "dependency_injection"
    | "runtime_registration"
    | "framework_route_handler"
    | "framework_implementation"
    | "framework_mount"
    | "framework_hook"
    | "framework_protection"
    | "prisma_query"
    | "prisma_update"
    | "reflection"
    | "generated";
  sourceNodeId: string;
  localName: string | null;
  importedName: string | null;
  provenance: ProvenanceCategory;
  confidence: number;
  metadata: Record<string, unknown>;
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
  readonly engine: "tree-sitter";
  /**
   * Exposes the adapter's syntax tree so downstream analyses such as CFG generation
   * do not need their own language/grammar switch statements.
   */
  createSyntaxTree(content: string): SyntaxNode;
  parseFile(input: ParseInput): ParsedFile;
}
