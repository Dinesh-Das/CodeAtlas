import { createEdgeId } from "../graph/ids.js";
import type {
  EdgeOwner,
  EdgeType,
  GraphEdge,
  ProvenanceCategory,
  SourceType,
} from "../graph/types.js";
import { provenanceForSource } from "../graph/types.js";
import type { AtlasDatabase } from "./database.js";
import { cachedStatement } from "./statements.js";

export function upsertEdge(
  database: AtlasDatabase,
  edge: GraphEdge,
  timestamp: string,
  owner: EdgeOwner = "extracted",
): void {
  cachedStatement(
    database,
      `INSERT INTO edges(
        id, source_node_id, target_node_id, edge_type, source_type, provenance_category,
        confidence, file_path, line, metadata_json, owner_kind, created_at, updated_at
      ) VALUES (
        @id, @sourceNodeId, @targetNodeId, @edgeType, @sourceType, @provenance,
        @confidence, @filePath, @line, @metadataJson, @owner, @timestamp, @timestamp
      )
      ON CONFLICT(id) DO UPDATE SET
        source_node_id = excluded.source_node_id,
        target_node_id = excluded.target_node_id,
        edge_type = excluded.edge_type,
        source_type = excluded.source_type,
        provenance_category = excluded.provenance_category,
        confidence = excluded.confidence,
        file_path = excluded.file_path,
        line = excluded.line,
        metadata_json = excluded.metadata_json,
        owner_kind = excluded.owner_kind,
        updated_at = excluded.updated_at`,
  ).run({
      ...edge,
      provenance: edge.provenance ?? provenanceForSource(edge.sourceType),
      metadataJson: JSON.stringify(edge.metadata),
      owner,
      timestamp,
    });
}

interface ProjectionEdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: EdgeType;
  source_type: SourceType;
  provenance_category: ProvenanceCategory;
  confidence: number;
  file_path: string;
  line: number | null;
  metadata_json: string;
  start_line: number | null;
  start_column: number | null;
}

/** Refreshes location-bearing architecture memberships without recomputing the projection. */
export function refreshArchitectureEdgeLocationsForFiles(
  database: AtlasDatabase,
  repositoryId: string,
  filePaths: readonly string[],
  timestamp: string,
): void {
  const select = database.prepare(
    `SELECT edges.id, edges.source_node_id, edges.target_node_id, edges.edge_type,
            edges.source_type, edges.provenance_category, edges.confidence,
            edges.file_path, edges.line, edges.metadata_json,
            source.start_line, source.start_column
     FROM edges
     JOIN nodes source ON source.id = edges.source_node_id
     WHERE edges.owner_kind = 'architecture_projection'
       AND edges.file_path = ?
     ORDER BY edges.id`,
  );
  const remove = cachedStatement(database, "DELETE FROM edges WHERE id = ?");
  for (const filePath of new Set(filePaths)) {
    const rows = select.all(filePath) as ProjectionEdgeRow[];
    for (const row of rows) {
      const line = row.start_line ?? row.line ?? 1;
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
      const evidence = metadata.evidence;
      if (
        typeof evidence === "object" &&
        evidence !== null &&
        !Array.isArray(evidence) &&
        (evidence as Record<string, unknown>).file === filePath
      ) {
        metadata = {
          ...metadata,
          evidence: {
            ...(evidence as Record<string, unknown>),
            line,
            column: row.start_column ?? 0,
          },
        };
      }
      const id = createEdgeId(
        repositoryId,
        row.edge_type,
        row.source_node_id,
        row.target_node_id,
        filePath,
        line,
      );
      if (
        id === row.id &&
        line === row.line &&
        JSON.stringify(metadata) === row.metadata_json
      ) continue;
      if (id !== row.id) remove.run(row.id);
      upsertEdge(
        database,
        {
          id,
          sourceNodeId: row.source_node_id,
          targetNodeId: row.target_node_id,
          edgeType: row.edge_type,
          sourceType: row.source_type,
          provenance: row.provenance_category,
          confidence: row.confidence,
          filePath,
          line,
          metadata,
        },
        timestamp,
        "architecture_projection",
      );
    }
  }
}

export function deleteEdgesForFile(database: AtlasDatabase, relativeFilePath: string): void {
  cachedStatement(database, "DELETE FROM edges WHERE file_path = ?").run(relativeFilePath);
}
