import type { UnresolvedReference } from "../parser/parser.js";
import type { FileSemanticFacts } from "../indexer/semantic-delta.js";
import type { AtlasDatabase } from "./database.js";
import { cachedStatement } from "./statements.js";

interface SemanticRow {
  path: string;
  token_fingerprint: string;
  symbols_fingerprint: string;
  imports_fingerprint: string;
  exports_fingerprint: string;
  references_fingerprint: string;
  public_api_fingerprint: string;
  framework_fingerprint: string;
  architecture_fingerprint: string;
  search_fingerprint: string;
  location_fingerprint: string;
  exported_symbols_json: string;
  references_json: string;
}

function fromRow(row: SemanticRow): FileSemanticFacts {
  return {
    path: row.path,
    tokenFingerprint: row.token_fingerprint,
    symbolsFingerprint: row.symbols_fingerprint,
    importsFingerprint: row.imports_fingerprint,
    exportsFingerprint: row.exports_fingerprint,
    referencesFingerprint: row.references_fingerprint,
    publicApiFingerprint: row.public_api_fingerprint,
    frameworkFingerprint: row.framework_fingerprint,
    architectureFingerprint: row.architecture_fingerprint,
    searchFingerprint: row.search_fingerprint,
    locationFingerprint: row.location_fingerprint,
    exportedSymbols: JSON.parse(row.exported_symbols_json) as FileSemanticFacts["exportedSymbols"],
    references: JSON.parse(row.references_json) as UnresolvedReference[],
  };
}

export function getFileSemanticFacts(
  database: AtlasDatabase,
  filePath: string,
): FileSemanticFacts | null {
  const row = database.prepare("SELECT * FROM file_semantics WHERE path = ?").get(filePath) as
    | SemanticRow
    | undefined;
  return row === undefined ? null : fromRow(row);
}

export function listFileSemanticFacts(database: AtlasDatabase): FileSemanticFacts[] {
  return (database.prepare("SELECT * FROM file_semantics ORDER BY path").all() as SemanticRow[])
    .map(fromRow);
}

export function listFileSemanticFactPaths(database: AtlasDatabase): string[] {
  return (
    database.prepare("SELECT path FROM file_semantics ORDER BY path").all() as Array<{
      path: string;
    }>
  ).map((row) => row.path);
}

export function getFileSemanticFactsForPaths(
  database: AtlasDatabase,
  filePaths: readonly string[],
): FileSemanticFacts[] {
  const uniquePaths = [...new Set(filePaths)];
  const facts: FileSemanticFacts[] = [];
  for (let offset = 0; offset < uniquePaths.length; offset += 400) {
    const chunk = uniquePaths.slice(offset, offset + 400);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(`SELECT * FROM file_semantics WHERE path IN (${placeholders}) ORDER BY path`)
      .all(...chunk) as SemanticRow[];
    facts.push(...rows.map(fromRow));
  }
  return facts;
}

export function upsertFileSemanticFacts(
  database: AtlasDatabase,
  facts: FileSemanticFacts,
  timestamp: string,
): void {
  cachedStatement(
    database,
    `INSERT INTO file_semantics(
       path, token_fingerprint, symbols_fingerprint, imports_fingerprint,
       exports_fingerprint, references_fingerprint, public_api_fingerprint,
       framework_fingerprint, architecture_fingerprint, search_fingerprint,
       location_fingerprint,
       exported_symbols_json, references_json, updated_at
     ) VALUES (
       @path, @tokenFingerprint, @symbolsFingerprint, @importsFingerprint,
       @exportsFingerprint, @referencesFingerprint, @publicApiFingerprint,
       @frameworkFingerprint, @architectureFingerprint, @searchFingerprint,
       @locationFingerprint,
       @exportedSymbolsJson, @referencesJson, @timestamp
     )
     ON CONFLICT(path) DO UPDATE SET
       token_fingerprint = excluded.token_fingerprint,
       symbols_fingerprint = excluded.symbols_fingerprint,
       imports_fingerprint = excluded.imports_fingerprint,
       exports_fingerprint = excluded.exports_fingerprint,
       references_fingerprint = excluded.references_fingerprint,
       public_api_fingerprint = excluded.public_api_fingerprint,
       framework_fingerprint = excluded.framework_fingerprint,
       architecture_fingerprint = excluded.architecture_fingerprint,
       search_fingerprint = excluded.search_fingerprint,
       location_fingerprint = excluded.location_fingerprint,
       exported_symbols_json = excluded.exported_symbols_json,
       references_json = excluded.references_json,
       updated_at = excluded.updated_at`,
  ).run({
    ...facts,
    exportedSymbolsJson: JSON.stringify(facts.exportedSymbols),
    referencesJson: JSON.stringify(facts.references),
    timestamp,
  });
}

export function deleteFileSemanticFacts(database: AtlasDatabase, filePath: string): void {
  cachedStatement(database, "DELETE FROM file_semantics WHERE path = ?").run(filePath);
}

export function upsertResolvedEdge(
  database: AtlasDatabase,
  filePath: string,
  edgeId: string,
): void {
  cachedStatement(
    database,
    `INSERT OR IGNORE INTO resolved_edges(file_path, edge_id) VALUES (?, ?)`,
  ).run([filePath, edgeId]);
}

export function deleteResolvedEdgesForFiles(
  database: AtlasDatabase,
  filePaths: readonly string[],
): void {
  const uniquePaths = [...new Set(filePaths)];
  for (let offset = 0; offset < uniquePaths.length; offset += 400) {
    const chunk = uniquePaths.slice(offset, offset + 400);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    database
      .prepare(
        `DELETE FROM edges
         WHERE id IN (
           SELECT edge_id FROM resolved_edges
           WHERE file_path IN (${placeholders})
         )`,
      )
      .run(...chunk);
  }
}

export function deleteExtractedEdgesForFile(database: AtlasDatabase, filePath: string): void {
  cachedStatement(
    database,
    `DELETE FROM edges
     WHERE file_path = ?
       AND owner_kind = 'extracted'
       AND edge_type <> 'RENAMED_FROM'
    `,
  ).run(filePath);
}
