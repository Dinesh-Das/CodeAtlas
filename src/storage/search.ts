import type { AtlasDatabase } from "./database.js";

export interface SearchResult {
  id: string;
  name: string;
  qualifiedName: string | null;
  filePath: string | null;
  rank: number;
}

export function searchNodes(database: AtlasDatabase, query: string, limit = 50): SearchResult[] {
  return database
    .prepare(
      `SELECT
        nodes.id,
        nodes.name,
        nodes.qualified_name AS qualifiedName,
        nodes.file_path AS filePath,
        bm25(nodes_fts) AS rank
      FROM nodes_fts
      JOIN nodes ON nodes.id = nodes_fts.id
      WHERE nodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
    )
    .all(query, limit) as SearchResult[];
}
