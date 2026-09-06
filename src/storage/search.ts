import type { AtlasDatabase } from "./database.js";

export interface SearchResult {
  id: string;
  name: string;
  qualifiedName: string | null;
  filePath: string | null;
  rank: number;
  match: "exact" | "fts";
}

export function searchNodes(database: AtlasDatabase, query: string, limit = 50): SearchResult[] {
  return (database
    .prepare(
      `SELECT
        nodes.id,
        nodes.name,
        nodes.qualified_name AS qualifiedName,
        nodes.file_path AS filePath,
        bm25(nodes_fts) AS rank,
        'fts' AS match
      FROM nodes_fts
      JOIN nodes ON nodes.rowid = nodes_fts.rowid
      WHERE nodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
    )
    .all(query, limit) as SearchResult[]);
}

export function ftsQueryFromText(value: string): string | null {
  const terms = [...new Set(value.toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_$-]+/u)
    .filter((term) => term.length > 1))]
    .slice(0, 20);
  return terms.length === 0
    ? null
    : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function searchExactNodes(
  database: AtlasDatabase,
  query: string,
  limit = 50,
): SearchResult[] {
  const normalizedPath = query.replaceAll("\\", "/");
  return database.prepare(
    `SELECT id, name, qualified_name AS qualifiedName, file_path AS filePath,
            -1000 AS rank, 'exact' AS match
     FROM nodes
     WHERE name = ? COLLATE NOCASE
        OR qualified_name = ? COLLATE NOCASE
        OR file_path = ? COLLATE NOCASE
     ORDER BY
       CASE
         WHEN name = ? COLLATE NOCASE THEN 0
         WHEN qualified_name = ? COLLATE NOCASE THEN 1
         ELSE 2
       END,
       id
     LIMIT ?`,
  ).all(query, query, normalizedPath, query, query, limit) as SearchResult[];
}

export function searchNodeCandidates(
  database: AtlasDatabase,
  query: string,
  limit = 1_000,
): SearchResult[] {
  const boundedLimit = Math.max(1, Math.min(10_001, limit));
  const exact = searchExactNodes(database, query, boundedLimit);
  const ftsQuery = ftsQueryFromText(query);
  const fts = ftsQuery === null ? [] : searchNodes(database, ftsQuery, boundedLimit);
  const merged = new Map<string, SearchResult>();
  for (const result of [...exact, ...fts]) {
    const current = merged.get(result.id);
    if (current === undefined || result.rank < current.rank) merged.set(result.id, result);
  }
  return [...merged.values()]
    .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id))
    .slice(0, boundedLimit);
}
