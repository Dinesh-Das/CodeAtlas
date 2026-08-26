import type { GraphNode } from "../graph/types.js";
import type { AtlasDatabase } from "./database.js";

export function upsertNode(database: AtlasDatabase, node: GraphNode, timestamp: string): void {
  database
    .prepare(
      `INSERT INTO nodes(
        id, kind, name, qualified_name, file_path, language,
        start_line, start_column, end_line, end_column,
        signature, visibility, content_hash, source_type, confidence,
        metadata_json, created_at, updated_at
      ) VALUES (
        @id, @kind, @name, @qualifiedName, @filePath, @language,
        @startLine, @startColumn, @endLine, @endColumn,
        @signature, @visibility, @contentHash, @sourceType, @confidence,
        @metadataJson, @timestamp, @timestamp
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        qualified_name = excluded.qualified_name,
        file_path = excluded.file_path,
        language = excluded.language,
        start_line = excluded.start_line,
        start_column = excluded.start_column,
        end_line = excluded.end_line,
        end_column = excluded.end_column,
        signature = excluded.signature,
        visibility = excluded.visibility,
        content_hash = excluded.content_hash,
        source_type = excluded.source_type,
        confidence = excluded.confidence,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    )
    .run({ ...node, metadataJson: JSON.stringify(node.metadata), timestamp });
}

export function deleteNodesForFile(database: AtlasDatabase, relativeFilePath: string): void {
  database
    .prepare("DELETE FROM nodes WHERE file_path = ? AND kind <> 'directory'")
    .run(relativeFilePath);
}

export function clearDirectoryNodes(database: AtlasDatabase): void {
  database.prepare("DELETE FROM nodes WHERE kind = 'directory'").run();
}
