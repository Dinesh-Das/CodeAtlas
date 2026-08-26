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
  "RENAMED_FROM",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export const SOURCE_TYPES = [
  "ast",
  "framework",
  "config",
  "schema",
  "git",
  "documentation",
  "heuristic",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

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
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: EdgeType;
  sourceType: SourceType;
  confidence: number;
  filePath: string | null;
  line: number | null;
  metadata: Record<string, unknown>;
}
