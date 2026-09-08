import { openDatabase } from "./database.js";
import { createEvidenceId } from "../ir/evidence.js";
import type { AtlasControlFlow, AtlasSymbol } from "../ir/models.js";
import { ftsQueryFromText, searchNodeCandidates, type SearchResult } from "./search.js";
import { performance } from "node:perf_hooks";

export interface SymbolCandidateProjection {
  items: SearchResult[];
  truncated: boolean;
}

export interface BoundedProjection<T> {
  items: T[];
  truncated: boolean;
}

export interface SymbolProjection {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
}

export interface RelationshipProjection {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
}

export interface EvidenceProjection {
  id: string;
  file: string;
  start_line: number;
  end_line: number;
  symbol_id: string | null;
  relationship_id: string | null;
  resolution_issue_id: string | null;
}

export interface QueryProjectionRequest {
  symbolIds?: readonly string[];
  relationships?: {
    symbolIds: readonly string[];
    direction: "incoming" | "outgoing" | "both";
    types?: readonly string[];
  };
  evidence?: {
    symbolIds?: readonly string[];
    relationshipIds?: readonly string[];
    resolutionIssueIds?: readonly string[];
  };
  limit: number;
}

export interface QueryProjection {
  symbols: BoundedProjection<SymbolProjection>;
  relationships: BoundedProjection<RelationshipProjection>;
  evidence: BoundedProjection<EvidenceProjection>;
}

export interface QueryStore {
  searchSymbols(query: string, limit: number): SymbolCandidateProjection;
  getSymbols(ids: readonly string[], limit: number): BoundedProjection<AtlasSymbol>;
  getSection<T>(section: string, limit: number, offset?: number): BoundedProjection<T>;
  cacheControlFlow(flow: AtlasControlFlow): void;
  queryProjection(request: QueryProjectionRequest): QueryProjection;
  metrics(): QueryStoreMetrics;
}

export interface QueryStoreMetrics {
  queries: number;
  rowsRead: number;
  bytesRead: number;
  elapsedMs: number;
}

function bounded<T>(items: T[], limit: number): BoundedProjection<T> {
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function selectedSymbols(
  database: ReturnType<typeof openDatabase>,
  ids: readonly string[],
  limit: number,
): BoundedProjection<SymbolProjection> {
  if (ids.length === 0) return { items: [], truncated: false };
  const rows = database.prepare(
    `SELECT id, kind, name, qualified_name, file_path, start_line, end_line
     FROM nodes
     WHERE id IN (${placeholders(ids)})
     ORDER BY id
     LIMIT ?`,
  ).all(...ids, limit + 1) as SymbolProjection[];
  return bounded(rows, limit);
}

function selectedRelationships(
  database: ReturnType<typeof openDatabase>,
  request: NonNullable<QueryProjectionRequest["relationships"]> | undefined,
  limit: number,
): BoundedProjection<RelationshipProjection> {
  if (request === undefined || request.symbolIds.length === 0) return { items: [], truncated: false };
  const ids = [...new Set(request.symbolIds)];
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  if (request.direction === "outgoing" || request.direction === "both") {
    clauses.push(`source_node_id IN (${placeholders(ids)})`);
    parameters.push(...ids);
  }
  if (request.direction === "incoming" || request.direction === "both") {
    clauses.push(`target_node_id IN (${placeholders(ids)})`);
    parameters.push(...ids);
  }
  const types = [...new Set(request.types ?? [])];
  const typeClause = types.length === 0 ? "" : ` AND edge_type IN (${placeholders(types)})`;
  parameters.push(...types, limit + 1);
  const rows = database.prepare(
    `SELECT id, source_node_id, target_node_id, edge_type
     FROM edges
     WHERE (${clauses.join(" OR ")})${typeClause}
     ORDER BY id
     LIMIT ?`,
  ).all(...parameters) as RelationshipProjection[];
  return bounded(rows, limit);
}

function selectedEvidence(
  database: ReturnType<typeof openDatabase>,
  request: QueryProjectionRequest["evidence"],
  limit: number,
): BoundedProjection<EvidenceProjection> {
  if (request === undefined) return { items: [], truncated: false };
  const rows: EvidenceProjection[] = [];
  const symbolIds = [...new Set(request.symbolIds ?? [])];
  if (symbolIds.length > 0) {
    const symbols = database.prepare(
      `SELECT id, file_path, start_line, start_column, end_line, end_column
       FROM nodes
       WHERE id IN (${placeholders(symbolIds)})
         AND file_path IS NOT NULL AND start_line IS NOT NULL
       ORDER BY id
       LIMIT ?`,
    ).all(...symbolIds, limit + 1) as Array<{
      id: string;
      file_path: string;
      start_line: number;
      start_column: number | null;
      end_line: number | null;
      end_column: number | null;
    }>;
    for (const symbol of symbols) {
      const endLine = Math.max(symbol.start_line, symbol.end_line ?? symbol.start_line);
      rows.push({
        id: createEvidenceId({
          file: symbol.file_path,
          startLine: symbol.start_line,
          startColumn: Math.max(0, symbol.start_column ?? 0),
          endLine,
          endColumn: Math.max(0, symbol.end_column ?? symbol.start_column ?? 0),
          symbolId: symbol.id,
        }),
        file: symbol.file_path,
        start_line: symbol.start_line,
        end_line: endLine,
        symbol_id: symbol.id,
        relationship_id: null,
        resolution_issue_id: null,
      });
    }
  }
  const relationshipIds = [...new Set(request.relationshipIds ?? [])];
  if (relationshipIds.length > 0 && rows.length <= limit) {
    const relationships = database.prepare(
      `SELECT id, file_path, line
       FROM edges
       WHERE id IN (${placeholders(relationshipIds)}) AND file_path IS NOT NULL
       ORDER BY id
       LIMIT ?`,
    ).all(...relationshipIds, limit + 1) as Array<{
      id: string;
      file_path: string;
      line: number | null;
    }>;
    for (const relationship of relationships) {
      const line = Math.max(1, relationship.line ?? 1);
      rows.push({
        id: createEvidenceId({
          file: relationship.file_path,
          startLine: line,
          startColumn: 0,
          endLine: line,
          endColumn: 0,
          relationshipId: relationship.id,
        }),
        file: relationship.file_path,
        start_line: line,
        end_line: line,
        symbol_id: null,
        relationship_id: relationship.id,
        resolution_issue_id: null,
      });
    }
  }
  const issueIds = [...new Set(request.resolutionIssueIds ?? [])];
  if (issueIds.length > 0 && rows.length <= limit) {
    const issues = database.prepare(
      `SELECT id, source_node_id, file_path, line, column_number
       FROM resolution_issues
       WHERE id IN (${placeholders(issueIds)})
       ORDER BY id
       LIMIT ?`,
    ).all(...issueIds, limit + 1) as Array<{
      id: string;
      source_node_id: string;
      file_path: string;
      line: number;
      column_number: number;
    }>;
    for (const issue of issues) {
      rows.push({
        id: createEvidenceId({
          file: issue.file_path,
          startLine: issue.line,
          startColumn: Math.max(0, issue.column_number),
          endLine: issue.line,
          endColumn: Math.max(0, issue.column_number),
          symbolId: issue.source_node_id,
          resolutionIssueId: issue.id,
        }),
        file: issue.file_path,
        start_line: issue.line,
        end_line: issue.line,
        symbol_id: issue.source_node_id,
        relationship_id: null,
        resolution_issue_id: issue.id,
      });
    }
  }
  return bounded([...new Map(rows.map((row) => [row.id, row])).values()], limit);
}

export class SqliteQueryStore implements QueryStore {
  private queryCount = 0;
  private rowCount = 0;
  private byteCount = 0;
  private queryElapsedMs = 0;

  constructor(private readonly databasePath: string) {}

  private record<T>(startedAt: number, rows: readonly T[]): void {
    this.queryCount += 1;
    this.rowCount += rows.length;
    this.byteCount += Buffer.byteLength(JSON.stringify(rows), "utf8");
    this.queryElapsedMs += performance.now() - startedAt;
  }

  metrics(): QueryStoreMetrics {
    return {
      queries: this.queryCount,
      rowsRead: this.rowCount,
      bytesRead: this.byteCount,
      elapsedMs: Number(this.queryElapsedMs.toFixed(3)),
    };
  }

  searchSymbols(query: string, limit: number): SymbolCandidateProjection {
    const requested = Math.max(1, Math.min(10_000, limit));
    const database = openDatabase(this.databasePath, { readonly: true });
    const startedAt = performance.now();
    try {
      const basic = searchNodeCandidates(database, query, requested + 1);
      const ftsQuery = ftsQueryFromText(query);
      const enriched = ftsQuery === null ? [] : database.prepare(
        `SELECT
           atlas_symbol_search.id,
           nodes.name,
           nodes.qualified_name AS qualifiedName,
           nodes.file_path AS filePath,
           bm25(atlas_symbol_search) AS rank,
           'fts' AS match
         FROM atlas_symbol_search
         JOIN nodes ON nodes.id = atlas_symbol_search.id
         WHERE atlas_symbol_search MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(ftsQuery, requested + 1) as SearchResult[];
      const merged = new Map<string, SearchResult>();
      for (const item of [...basic, ...enriched]) {
        const current = merged.get(item.id);
        if (current === undefined || item.rank < current.rank) merged.set(item.id, item);
      }
      const items = [...merged.values()]
        .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
      this.record(startedAt, items.slice(0, requested + 1));
      return {
        items: items.slice(0, requested),
        truncated: items.length > requested,
      };
    } finally {
      database.close();
    }
  }

  getSymbols(ids: readonly string[], limit: number): BoundedProjection<AtlasSymbol> {
    const requested = Math.max(1, Math.min(10_000, limit));
    const selectedIds = [...new Set(ids)].slice(0, requested + 1);
    if (selectedIds.length === 0) return { items: [], truncated: false };
    const database = openDatabase(this.databasePath, { readonly: true });
    const startedAt = performance.now();
    try {
      const values = new Map<string, AtlasSymbol>();
      const chunkSize = 500;
      for (let offset = 0; offset < selectedIds.length; offset += chunkSize) {
        const chunk = selectedIds.slice(offset, offset + chunkSize);
        const rows = database.prepare(
          `SELECT item_id, payload_json
           FROM atlas_sections
           WHERE section = 'symbols' AND item_id IN (${placeholders(chunk)})`,
        ).all(...chunk) as Array<{ item_id: string; payload_json: string }>;
        for (const row of rows) values.set(row.item_id, JSON.parse(row.payload_json) as AtlasSymbol);
      }
      const items = selectedIds.flatMap((id) => values.get(id) ?? []);
      this.record(startedAt, items);
      return bounded(items, requested);
    } finally {
      database.close();
    }
  }

  getSection<T>(section: string, limit: number, offset = 0): BoundedProjection<T> {
    const requested = Math.max(1, Math.min(10_000, limit));
    const safeOffset = Math.max(0, Math.floor(offset));
    const database = openDatabase(this.databasePath, { readonly: true });
    const startedAt = performance.now();
    try {
      const rows = database.prepare(
        `SELECT payload_json FROM atlas_sections
         WHERE section = ? ORDER BY ordinal LIMIT ? OFFSET ?`,
      ).all(section, requested + 1, safeOffset) as Array<{ payload_json: string }>;
      const items = rows.map((row) => JSON.parse(row.payload_json) as T);
      this.record(startedAt, items);
      return bounded(items, requested);
    } finally {
      database.close();
    }
  }

  cacheControlFlow(flow: AtlasControlFlow): void {
    const database = openDatabase(this.databasePath);
    try {
      database.transaction(() => {
        database.prepare(
          `INSERT INTO atlas_sections(section, ordinal, item_id, payload_json)
           VALUES ('control_flows',
             COALESCE((SELECT MAX(ordinal) + 1 FROM atlas_sections WHERE section = 'control_flows'), 0),
             ?, ?)
           ON CONFLICT(section, item_id) DO UPDATE SET payload_json = excluded.payload_json`,
        ).run(flow.id, JSON.stringify(flow));
        const metadata = database.prepare("SELECT payload_json FROM atlas_metadata WHERE id = 1").get() as
          | { payload_json: string }
          | undefined;
        if (metadata !== undefined) {
          const manifest = JSON.parse(metadata.payload_json) as {
            section_counts: Record<string, number>;
          };
          manifest.section_counts.control_flows = (database.prepare(
            "SELECT COUNT(*) AS count FROM atlas_sections WHERE section = 'control_flows'",
          ).get() as { count: number }).count;
          database.prepare(
            "UPDATE atlas_metadata SET payload_json = ?, updated_at = ? WHERE id = 1",
          ).run(JSON.stringify(manifest), new Date().toISOString());
        }
      })();
    } finally {
      database.close();
    }
  }

  queryProjection(request: QueryProjectionRequest): QueryProjection {
    const limit = Math.max(1, Math.min(10_000, request.limit));
    const database = openDatabase(this.databasePath, { readonly: true });
    const startedAt = performance.now();
    try {
      const result = {
        symbols: selectedSymbols(database, [...new Set(request.symbolIds ?? [])], limit),
        relationships: selectedRelationships(database, request.relationships, limit),
        evidence: selectedEvidence(database, request.evidence, limit),
      };
      this.record(startedAt, [
        ...result.symbols.items,
        ...result.relationships.items,
        ...result.evidence.items,
      ]);
      return result;
    } finally {
      database.close();
    }
  }
}
