export const NODE_KINDS = [
  "repository",
  "package",
  "directory",
  "module",
  "file",
  "class",
  "interface",
  "function",
  "method",
  "variable",
  "api_route",
  "database_model",
  "database_table",
  "configuration",
  "documentation",
  "external_service",
  "test",
  "feature",
  "domain",
  "event",
  "queue",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_TYPES = [
  "CONTAINS",
  "IMPORTS",
  "EXPORTS",
  "CALLS",
  "REFERENCES",
  "EXTENDS",
  "IMPLEMENTS",
  "DEPENDS_ON",
  "READS_FROM",
  "WRITES_TO",
  "EXPOSES",
  "HANDLES",
  "TRIGGERS",
  "PUBLISHES",
  "SUBSCRIBES",
  "TESTS",
  "BELONGS_TO_FEATURE",
  "BELONGS_TO_DOMAIN",
  "CONFIGURES",
  "USES_EXTERNAL_SERVICE",
  "MOUNTS",
  "APPLIES_HOOK",
  "DECORATES",
  "IMPLEMENTED_BY",
  "PROTECTED_BY",
  "MAY_CONTINUE_TO",
  "ROUTE_PREFIX",
  "QUERIES",
  "UPDATES",
  "RENAMED_FROM",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export const SOURCE_TYPES = [
  "ast",
  "compiler",
  "framework",
  "config",
  "schema",
  "git",
  "documentation",
  "heuristic",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const PROVENANCE_CATEGORIES = [
  "verified",
  "inferred",
  "dynamic",
  "documentation",
  "git",
  "unresolved",
] as const;

export type ProvenanceCategory = (typeof PROVENANCE_CATEGORIES)[number];

export function provenanceForSource(sourceType: SourceType): ProvenanceCategory {
  if (sourceType === "heuristic") return "inferred";
  if (sourceType === "documentation") return "documentation";
  if (sourceType === "git") return "git";
  return "verified";
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string | null;
  filePath: string | null;
  language: string | null;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
  signature: string | null;
  visibility: string | null;
  contentHash: string | null;
  sourceType: SourceType;
  provenance: ProvenanceCategory;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: EdgeType;
  sourceType: SourceType;
  provenance: ProvenanceCategory;
  confidence: number;
  filePath: string | null;
  line: number | null;
  metadata: Record<string, unknown>;
}

export type EdgeOwner =
  | "extracted"
  | "resolved"
  | "framework_projection"
  | "architecture_projection"
  | "rename_history";
