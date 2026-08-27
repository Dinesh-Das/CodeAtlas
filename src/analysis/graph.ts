import type { SourceType } from "../graph/types.js";
import type { AtlasDatabase } from "../storage/database.js";
import type { AnalysisNode, DependencyLink, FileGraph } from "./types.js";

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  confidence: number;
  source_type: SourceType;
}

interface LinkRow {
  id: string;
  source_file: string;
  target_file: string;
  edge_type: string;
  file_path: string | null;
  line: number | null;
  confidence: number;
  source_type: SourceType;
}

const NON_DEPENDENCY_EDGES = [
  "CONTAINS",
  "EXPORTS",
  "BELONGS_TO_FEATURE",
  "BELONGS_TO_DOMAIN",
  "RENAMED_FROM",
] as const;

export function loadFileGraph(database: AtlasDatabase): FileGraph {
  const nodes = (
    database
      .prepare(
        `SELECT id, kind, name, qualified_name, file_path, start_line, start_column,
                end_line, confidence, source_type
         FROM nodes
         WHERE kind NOT IN ('feature', 'domain')
         ORDER BY file_path, start_line, id`,
      )
      .all() as NodeRow[]
  ).map(
    (row): AnalysisNode => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualified_name,
      filePath: row.file_path,
      startLine: row.start_line,
      startColumn: row.start_column,
      endLine: row.end_line,
      confidence: row.confidence,
      sourceType: row.source_type,
    }),
  );
  const analyzablePaths = new Set(
    nodes
      .filter((node) =>
        ["module", "api_route", "database_model"].includes(node.kind),
      )
      .map((node) => node.filePath)
      .filter((filePath): filePath is string => filePath !== null),
  );
  const fileNodes = new Map(
    nodes
      .filter(
        (node) =>
          node.kind === "file" &&
          node.filePath !== null &&
          analyzablePaths.has(node.filePath),
      )
      .map((node) => [node.filePath!, node]),
  );
  const placeholders = NON_DEPENDENCY_EDGES.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT edges.id, source.file_path AS source_file, target.file_path AS target_file,
              edges.edge_type, edges.file_path, edges.line, edges.confidence,
              edges.source_type
       FROM edges
       JOIN nodes source ON source.id = edges.source_node_id
       JOIN nodes target ON target.id = edges.target_node_id
       WHERE source.file_path IS NOT NULL
         AND target.file_path IS NOT NULL
         AND source.file_path <> target.file_path
         AND edges.edge_type NOT IN (${placeholders})
       ORDER BY source.file_path, target.file_path, edges.id`,
    )
    .all(...NON_DEPENDENCY_EDGES) as LinkRow[];
  const linksByPair = new Map<string, DependencyLink>();
  for (const row of rows) {
    if (!fileNodes.has(row.source_file) || !fileNodes.has(row.target_file)) continue;
    const key = `${row.source_file}\0${row.target_file}`;
    const candidate: DependencyLink = {
      id: row.id,
      sourceFile: row.source_file,
      targetFile: row.target_file,
      edgeType: row.edge_type,
      filePath: row.file_path ?? row.source_file,
      line: row.line ?? 1,
      confidence: row.confidence,
      sourceType: row.source_type,
    };
    const current = linksByPair.get(key);
    if (current === undefined || candidate.confidence > current.confidence) {
      linksByPair.set(key, candidate);
    }
  }
  const links = [...linksByPair.values()];
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const filePath of fileNodes.keys()) {
    outgoing.set(filePath, new Set());
    incoming.set(filePath, new Set());
  }
  for (const link of links) {
    outgoing.get(link.sourceFile)?.add(link.targetFile);
    incoming.get(link.targetFile)?.add(link.sourceFile);
  }
  return { fileNodes, nodes, links, outgoing, incoming };
}
