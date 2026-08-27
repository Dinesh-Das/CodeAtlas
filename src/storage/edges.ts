import type { GraphEdge } from "../graph/types.js";
import type { AtlasDatabase } from "./database.js";

export function upsertEdge(database: AtlasDatabase, edge: GraphEdge, timestamp: string): void {
  database
    .prepare(
      `INSERT INTO edges(
        id, source_node_id, target_node_id, edge_type, source_type,
        confidence, file_path, line, metadata_json, created_at, updated_at
      ) VALUES (
        @id, @sourceNodeId, @targetNodeId, @edgeType, @sourceType,
        @confidence, @filePath, @line, @metadataJson, @timestamp, @timestamp
      )
      ON CONFLICT(id) DO UPDATE SET
        source_node_id = excluded.source_node_id,
        target_node_id = excluded.target_node_id,
        edge_type = excluded.edge_type,
        source_type = excluded.source_type,
        confidence = excluded.confidence,
        file_path = excluded.file_path,
        line = excluded.line,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    )
    .run({ ...edge, metadataJson: JSON.stringify(edge.metadata), timestamp });
}

export function deleteEdgesForFile(database: AtlasDatabase, relativeFilePath: string): void {
  database.prepare("DELETE FROM edges WHERE file_path = ?").run(relativeFilePath);
}
