import type { AtlasDatabase } from "./database.js";

export type ResolutionIssueReason =
  | "unresolved_reference"
  | "multi_candidate"
  | "dynamic_relationship"
  | "generated_code"
  | "unsupported_framework";

export interface ResolutionIssue {
  id: string;
  sourceNodeId: string;
  referenceKind: string;
  referenceName: string | null;
  referenceHash: string;
  filePath: string;
  line: number;
  column: number;
  reason: ResolutionIssueReason;
  candidateNodeIds: string[];
  metadata: Record<string, unknown>;
}

export function upsertResolutionIssue(
  database: AtlasDatabase,
  issue: ResolutionIssue,
  timestamp: string,
): void {
  database
    .prepare(
      `INSERT INTO resolution_issues(
        id, source_node_id, reference_kind, reference_name, reference_hash,
        file_path, line, column_number, reason, candidate_node_ids_json,
        metadata_json, created_at, updated_at
      ) VALUES (
        @id, @sourceNodeId, @referenceKind, @referenceName, @referenceHash,
        @filePath, @line, @column, @reason, @candidateNodeIdsJson,
        @metadataJson, @timestamp, @timestamp
      )
      ON CONFLICT(id) DO UPDATE SET
        source_node_id = excluded.source_node_id,
        reference_kind = excluded.reference_kind,
        reference_name = excluded.reference_name,
        reference_hash = excluded.reference_hash,
        file_path = excluded.file_path,
        line = excluded.line,
        column_number = excluded.column_number,
        reason = excluded.reason,
        candidate_node_ids_json = excluded.candidate_node_ids_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    )
    .run({
      ...issue,
      candidateNodeIdsJson: JSON.stringify(issue.candidateNodeIds),
      metadataJson: JSON.stringify(issue.metadata),
      timestamp,
    });
}

export function listResolutionIssues(
  database: AtlasDatabase,
  limit: number,
): ResolutionIssue[] {
  const rows = database
    .prepare(
      `SELECT
        id, source_node_id, reference_kind, reference_name, reference_hash,
        file_path, line, column_number, reason, candidate_node_ids_json, metadata_json
       FROM resolution_issues
       ORDER BY file_path, line, column_number, reference_kind
       LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string;
      source_node_id: string;
      reference_kind: string;
      reference_name: string | null;
      reference_hash: string;
      file_path: string;
      line: number;
      column_number: number;
      reason: ResolutionIssueReason;
      candidate_node_ids_json: string;
      metadata_json: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    sourceNodeId: row.source_node_id,
    referenceKind: row.reference_kind,
    referenceName: row.reference_name,
    referenceHash: row.reference_hash,
    filePath: row.file_path,
    line: row.line,
    column: row.column_number,
    reason: row.reason,
    candidateNodeIds: JSON.parse(row.candidate_node_ids_json) as string[],
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  }));
}

export function deleteResolutionIssuesForFile(
  database: AtlasDatabase,
  relativeFilePath: string,
): void {
  database.prepare("DELETE FROM resolution_issues WHERE file_path = ?").run(relativeFilePath);
}
