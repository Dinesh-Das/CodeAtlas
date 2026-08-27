import type { SourceType } from "../graph/types.js";
import { workspacePaths } from "../core/workspace.js";
import { openDatabase, type AtlasDatabase } from "../storage/database.js";
import type { FreshContext } from "./freshness.js";
import {
  decodeCursor as decodeOffset,
  encodeCursor as encodeOffset,
  evidenceFrom as evidence,
  freshnessFor as freshness,
  parseMetadata as metadata,
} from "./query.js";
import { answerPacketSchema, type AnswerPacket } from "./schemas.js";

interface PageInput {
  cursor?: string | null;
  limit: number;
}

interface OverviewRow {
  id: string;
  kind:
    | "domain"
    | "feature"
    | "dependency_community"
    | "api_route"
    | "database_model";
  name: string;
  file_path: string | null;
  start_line: number | null;
  source_type: SourceType;
  confidence: number;
  metadata_json: string | null;
}

interface FindingRow {
  id: string;
  finding_type: string;
  severity: string;
  title: string;
  file_path: string;
  line: number;
  source_type: SourceType;
  confidence: number;
  evidence_node_ids_json: string;
  metadata_json: string;
}

interface EdgeRow {
  source_node_id: string;
  target_node_id: string;
  edge_type: AnswerPacket["relationships"][number]["edge_type"];
  confidence: number;
  source_type: SourceType;
  file_path: string | null;
  line: number | null;
  metadata_json: string | null;
}

function overviewStatement(row: OverviewRow, value: Record<string, unknown>): string {
  switch (row.kind) {
    case "domain":
      return `Domain ${row.name} groups ${String(value.member_file_count ?? "multiple")} repository files.`;
    case "feature":
      return `Feature ${row.name} groups ${String(value.semantic_member_count ?? "multiple")} semantic graph entities.`;
    case "dependency_community":
      return `Dependency community ${row.name} contains ${String(value.member_file_count ?? "multiple")} source or model files.`;
    case "api_route":
      return `API route ${row.name} is exposed by the repository.`;
    case "database_model":
      return `Database model ${row.name} is defined by ${String(value.framework ?? "a detected framework")}.`;
  }
}

function relationshipsForNodes(
  database: AtlasDatabase,
  nodeIds: readonly string[],
  limit: number,
): AnswerPacket["relationships"] {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT source_node_id, target_node_id, edge_type, confidence, source_type,
              file_path, line, metadata_json
       FROM edges
       WHERE (source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))
         AND edge_type IN (
           'BELONGS_TO_FEATURE', 'BELONGS_TO_DOMAIN', 'EXPOSES', 'HANDLES', 'REFERENCES'
         )
       ORDER BY edge_type, source_node_id, target_node_id
       LIMIT ?`,
    )
    .all(...nodeIds, ...nodeIds, limit) as EdgeRow[];
  return rows.map((row) => {
    const edgeEvidence = evidence(metadata(row.metadata_json), row.file_path, row.line);
    return {
      source_node_id: row.source_node_id,
      target_node_id: row.target_node_id,
      edge_type: row.edge_type,
      confidence: row.confidence,
      source_type: row.source_type,
      evidence: { file: edgeEvidence.file, line: edgeEvidence.line },
    };
  });
}

export function architectureOverviewPacket(
  context: FreshContext,
  input: PageInput,
): AnswerPacket {
  const offset = decodeOffset(input.cursor, "overview");
  const database = openDatabase(workspacePaths(context.status.root).database, {
    readonly: true,
  });
  try {
    const rows = database
      .prepare(
        `WITH overview_items AS (
           SELECT id, kind, name, file_path, start_line, source_type,
                  confidence, metadata_json
           FROM nodes
           WHERE kind IN ('domain', 'feature', 'api_route', 'database_model')
           UNION ALL
           SELECT community_id AS id,
                  'dependency_community' AS kind,
                  substr(community_id, 1, 8) AS name,
                  min(file_path) AS file_path,
                  1 AS start_line,
                  'heuristic' AS source_type,
                  0.9 AS confidence,
                  json_object(
                    'member_file_count', max(member_count),
                    'evidence', json_object(
                      'source_type', 'heuristic',
                      'file', min(file_path),
                      'line', 1,
                      'column', 0
                    )
                  ) AS metadata_json
           FROM dependency_communities
           GROUP BY community_id
         )
         SELECT id, kind, name, file_path, start_line, source_type, confidence, metadata_json
         FROM overview_items
         ORDER BY CASE kind
           WHEN 'domain' THEN 1 WHEN 'feature' THEN 2
           WHEN 'dependency_community' THEN 3
           WHEN 'api_route' THEN 4 ELSE 5 END,
           name, id
         LIMIT ? OFFSET ?`,
      )
      .all(input.limit + 1, offset) as OverviewRow[];
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const heuristicIds = page
      .filter((row) => row.source_type === "heuristic")
      .map((row) => row.id);
    return answerPacketSchema.parse({
      answer_context: { topic: "repository overview", tool: "codeatlas_overview" },
      facts: page.map((row) => {
        const value = metadata(row.metadata_json);
        return {
          statement: overviewStatement(row, value),
          confidence: row.confidence,
          source_type: row.source_type,
          evidence: evidence(value, row.file_path, row.start_line),
        };
      }),
      relationships: relationshipsForNodes(
        database,
        page.map((row) => row.id),
        context.config.limits.maxMcpResultNodes,
      ),
      source_snippets: [],
      uncertainties:
        page.length === 0
          ? [
              {
                description: "No architecture groups, API routes, or database models were detected.",
                reason: "insufficient_evidence",
                candidates: [],
              },
            ]
          : heuristicIds.length > 0
            ? [
                {
                  description: "Feature and domain groups are deterministic heuristic inferences.",
                  reason: "heuristic_only",
                  candidates: heuristicIds,
                },
              ]
            : [],
      freshness: freshness(context),
      pagination: {
        cursor: hasMore ? encodeOffset(offset + input.limit, "overview") : null,
        has_more: hasMore,
      },
    });
  } finally {
    database.close();
  }
}

function cycleRelationships(
  database: AtlasDatabase,
  findings: readonly FindingRow[],
  limit: number,
): AnswerPacket["relationships"] {
  const edgeIds = findings.flatMap((finding) => {
    const value = metadata(finding.metadata_json);
    return Array.isArray(value.edge_ids)
      ? value.edge_ids.filter((id): id is string => typeof id === "string")
      : [];
  });
  if (edgeIds.length === 0) return [];
  const selected = [...new Set(edgeIds)].slice(0, limit);
  const placeholders = selected.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT source_node_id, target_node_id, edge_type, confidence, source_type,
              file_path, line, metadata_json
       FROM edges WHERE id IN (${placeholders}) ORDER BY id`,
    )
    .all(...selected) as EdgeRow[];
  return rows.map((row) => {
    const edgeEvidence = evidence(metadata(row.metadata_json), row.file_path, row.line);
    return {
      source_node_id: row.source_node_id,
      target_node_id: row.target_node_id,
      edge_type: row.edge_type,
      confidence: row.confidence,
      source_type: row.source_type,
      evidence: { file: edgeEvidence.file, line: edgeEvidence.line },
    };
  });
}

export function architectureHealthPacket(
  context: FreshContext,
  input: PageInput,
): AnswerPacket {
  const offset = decodeOffset(input.cursor, "health");
  const database = openDatabase(workspacePaths(context.status.root).database, {
    readonly: true,
  });
  try {
    const rows = database
      .prepare(
        `SELECT id, finding_type, severity, title, file_path, line, source_type,
                confidence, evidence_node_ids_json, metadata_json
         FROM architecture_findings
         ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                  finding_type, file_path, line, id
         LIMIT ? OFFSET ?`,
      )
      .all(input.limit + 1, offset) as FindingRow[];
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const fallbackMetric = database
      .prepare(
        `SELECT file_path FROM architecture_metrics
         ORDER BY fan_in + fan_out DESC, file_path LIMIT 1`,
      )
      .get() as { file_path: string } | undefined;
    const facts = page.map((row) => ({
      statement: `${row.severity.toUpperCase()} signal: ${row.title}.`,
      confidence: row.confidence,
      source_type: row.source_type,
      evidence: evidence(metadata(row.metadata_json), row.file_path, row.line),
    }));
    if (facts.length === 0 && !context.config.analysis.technicalDebt) {
      facts.push({
        statement: "Technical-debt signal generation is disabled by configuration.",
        confidence: 0.9,
        source_type: "config",
        evidence: { file: ".codeatlas/config.json", line: 1 },
      });
    } else if (facts.length === 0 && fallbackMetric !== undefined) {
      facts.push({
        statement: "No architecture metrics crossed the configured signal thresholds.",
        confidence: 0.9,
        source_type: "heuristic",
        evidence: { file: fallbackMetric.file_path, line: 1 },
      });
    }
    const heuristicCandidates = page
      .filter((row) => row.source_type === "heuristic")
      .flatMap((row) => JSON.parse(row.evidence_node_ids_json) as string[]);
    return answerPacketSchema.parse({
      answer_context: { topic: "repository health", tool: "codeatlas_health" },
      facts,
      relationships: cycleRelationships(
        database,
        page,
        context.config.limits.maxMcpResultNodes,
      ),
      source_snippets: [],
      uncertainties:
        facts.length === 0
          ? [
              {
                description: "No analyzable source graph was available for health signals.",
                reason: "insufficient_evidence",
                candidates: [],
              },
            ]
          : heuristicCandidates.length > 0
          ? [
              {
                description: "Architecture health entries are signals, not definitive quality judgments.",
                reason: "heuristic_only",
                candidates: [...new Set(heuristicCandidates)],
              },
            ]
          : [],
      freshness: freshness(context),
      pagination: {
        cursor: hasMore ? encodeOffset(offset + input.limit, "health") : null,
        has_more: hasMore,
      },
    });
  } finally {
    database.close();
  }
}
