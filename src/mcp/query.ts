import { sha256 } from "../core/hashing.js";
import { CodeAtlasError } from "../core/errors.js";
import type { EdgeType, NodeKind, SourceType } from "../graph/types.js";
import type { AtlasDatabase } from "../storage/database.js";
import type { FreshContext } from "./freshness.js";
import type { AnswerPacket } from "./schemas.js";

export interface StoredNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string | null;
  filePath: string | null;
  language: string | null;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
  signature: string | null;
  visibility: string | null;
  sourceType: SourceType;
  confidence: number;
  metadataJson: string | null;
}

export interface StoredEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: EdgeType;
  sourceType: SourceType;
  confidence: number;
  filePath: string | null;
  line: number | null;
  metadataJson: string | null;
}

interface ResolutionIssueRow {
  reason: "unresolved_reference" | "multi_candidate";
  reference_name: string | null;
  candidate_node_ids_json: string;
  file_path: string;
  line: number;
}

const NODE_COLUMNS = `
  id, kind, name, qualified_name AS qualifiedName, file_path AS filePath,
  language, start_line AS startLine, start_column AS startColumn,
  end_line AS endLine, end_column AS endColumn, signature, visibility,
  source_type AS sourceType, confidence, metadata_json AS metadataJson
`;

const EDGE_COLUMNS = `
  id, source_node_id AS sourceNodeId, target_node_id AS targetNodeId,
  edge_type AS edgeType, source_type AS sourceType, confidence,
  file_path AS filePath, line, metadata_json AS metadataJson
`;

export function parseMetadata(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function evidenceFrom(
  metadata: Record<string, unknown>,
  fallbackFile: string | null,
  fallbackLine: number | null,
  fallbackColumn?: number | null,
): AnswerPacket["facts"][number]["evidence"] {
  const stored = metadata.evidence;
  if (typeof stored === "object" && stored !== null) {
    const value = stored as { file?: unknown; line?: unknown; column?: unknown };
    if (typeof value.file === "string" && typeof value.line === "number" && value.line > 0) {
      return {
        file: value.file,
        line: value.line,
        ...(typeof value.column === "number" && value.column >= 0
          ? { column: value.column }
          : {}),
      };
    }
  }
  return {
    file: fallbackFile ?? ".codeatlas/state.json",
    line: fallbackLine ?? 1,
    ...(fallbackColumn !== null && fallbackColumn !== undefined && fallbackColumn >= 0
      ? { column: fallbackColumn }
      : {}),
  };
}

export function evidenceForNode(node: StoredNode): AnswerPacket["facts"][number]["evidence"] {
  return evidenceFrom(
    parseMetadata(node.metadataJson),
    node.filePath,
    node.startLine,
    node.startColumn,
  );
}

export function relationshipFromEdge(edge: StoredEdge): AnswerPacket["relationships"][number] {
  const evidence = evidenceFrom(parseMetadata(edge.metadataJson), edge.filePath, edge.line);
  return {
    source_node_id: edge.sourceNodeId,
    target_node_id: edge.targetNodeId,
    edge_type: edge.edgeType,
    confidence: edge.confidence,
    source_type: edge.sourceType,
    evidence: { file: evidence.file, line: evidence.line },
  };
}

export function freshnessFor(context: FreshContext): AnswerPacket["freshness"] {
  return {
    fingerprint: context.status.currentFingerprint,
    head_commit: context.status.headCommit,
    working_tree_checked: true,
    checked_at: context.checkedAt,
  };
}

function cursorScope(value: string): string {
  return sha256(value);
}

export function decodeCursor(
  cursor: string | null | undefined,
  kind: string,
  scope = "",
): number {
  if (cursor === null || cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      version?: unknown;
      kind?: unknown;
      scope?: unknown;
      offset?: unknown;
    };
    if (
      value.version !== 1 ||
      value.kind !== kind ||
      value.scope !== cursorScope(scope) ||
      !Number.isInteger(value.offset) ||
      (value.offset as number) < 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return value.offset as number;
  } catch (error) {
    throw new CodeAtlasError("Invalid pagination cursor.", { cause: error });
  }
}

export function encodeCursor(offset: number, kind: string, scope = ""): string {
  return Buffer.from(
    JSON.stringify({ version: 1, kind, scope: cursorScope(scope), offset }),
    "utf8",
  ).toString("base64url");
}

export function getNodeById(database: AtlasDatabase, nodeId: string): StoredNode | undefined {
  return database
    .prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`)
    .get(nodeId) as StoredNode | undefined;
}

export function getNodesByIds(
  database: AtlasDatabase,
  nodeIds: readonly string[],
): StoredNode[] {
  if (nodeIds.length === 0) return [];
  const uniqueIds = [...new Set(nodeIds)];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  return database
    .prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id IN (${placeholders}) ORDER BY id`)
    .all(...uniqueIds) as StoredNode[];
}

export interface TargetResolution {
  node: StoredNode | null;
  uncertainty: AnswerPacket["uncertainties"][number] | null;
}

export function resolveTarget(
  database: AtlasDatabase,
  target: string,
  kinds?: readonly NodeKind[],
): TargetResolution {
  const byId = getNodeById(database, target);
  if (byId !== undefined && (kinds === undefined || kinds.includes(byId.kind))) {
    return { node: byId, uncertainty: null };
  }

  const parameters: unknown[] = [target, target];
  let kindClause = "";
  if (kinds !== undefined && kinds.length > 0) {
    kindClause = ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
    parameters.push(...kinds);
  }
  const candidates = database
    .prepare(
      `SELECT ${NODE_COLUMNS}
       FROM nodes
       WHERE (name = ? COLLATE NOCASE OR qualified_name = ? COLLATE NOCASE)
         ${kindClause}
       ORDER BY CASE WHEN qualified_name = ? COLLATE NOCASE THEN 0 ELSE 1 END,
                file_path, start_line, id
       LIMIT 51`,
    )
    .all(...parameters, target) as StoredNode[];

  if (candidates.length === 1) return { node: candidates[0]!, uncertainty: null };
  if (candidates.length > 1) {
    return {
      node: null,
      uncertainty: {
        description: `The target ${JSON.stringify(target)} matches multiple graph nodes; CodeAtlas did not guess.`,
        reason: "multi_candidate",
        candidates: candidates.map((candidate) => candidate.id),
      },
    };
  }
  return {
    node: null,
    uncertainty: {
      description: `CodeAtlas could not verify a graph node matching ${JSON.stringify(target)}.`,
      reason: "unresolved_reference",
      candidates: [],
    },
  };
}

export function nodeFact(node: StoredNode, prefix = "Graph node"): AnswerPacket["facts"][number] {
  const qualified = node.qualifiedName === null || node.qualifiedName === node.name
    ? node.name
    : `${node.name} (${node.qualifiedName})`;
  const location = node.filePath === null
    ? "the repository graph"
    : `${node.filePath}:${node.startLine ?? 1}`;
  return {
    statement: `${prefix} ${qualified} [node_id: ${node.id}] is a ${node.kind} at ${location}.`,
    confidence: node.confidence,
    source_type: node.sourceType,
    evidence: evidenceForNode(node),
  };
}

export function listEdgesForNode(
  database: AtlasDatabase,
  nodeId: string,
  direction: "incoming" | "outgoing" | "both",
  limit: number,
  offset = 0,
  edgeTypes?: readonly EdgeType[],
): StoredEdge[] {
  const predicate = direction === "incoming"
    ? "target_node_id = ?"
    : direction === "outgoing"
      ? "source_node_id = ?"
      : "(source_node_id = ? OR target_node_id = ?)";
  const parameters = direction === "both" ? [nodeId, nodeId] : [nodeId];
  const edgeTypeClause = edgeTypes === undefined || edgeTypes.length === 0
    ? ""
    : ` AND edge_type IN (${edgeTypes.map(() => "?").join(", ")})`;
  return database
    .prepare(
      `SELECT ${EDGE_COLUMNS} FROM edges
       WHERE ${predicate}${edgeTypeClause}
       ORDER BY edge_type, source_node_id, target_node_id, id
       LIMIT ? OFFSET ?`,
    )
    .all(...parameters, ...(edgeTypes ?? []), limit, offset) as StoredEdge[];
}

export function uncertaintiesForNodes(
  database: AtlasDatabase,
  nodeIds: readonly string[],
  limit: number,
): AnswerPacket["uncertainties"] {
  if (nodeIds.length === 0) return [];
  const uniqueIds = [...new Set(nodeIds)];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT reason, reference_name, candidate_node_ids_json, file_path, line
       FROM resolution_issues
       WHERE source_node_id IN (${placeholders})
       ORDER BY file_path, line, reason
       LIMIT ?`,
    )
    .all(...uniqueIds, limit) as ResolutionIssueRow[];
  return rows.map((row) => {
    let candidates: string[] = [];
    try {
      const parsed = JSON.parse(row.candidate_node_ids_json) as unknown;
      if (Array.isArray(parsed)) {
        candidates = parsed.filter((candidate): candidate is string => typeof candidate === "string");
      }
    } catch {
      candidates = [];
    }
    const reference = row.reference_name === null ? "a redacted reference" : row.reference_name;
    return {
      description: `${reference} at ${row.file_path}:${row.line} was ${row.reason === "multi_candidate" ? "ambiguous" : "not resolved"}.`,
      reason: row.reason,
      candidates,
    };
  });
}

export function edgeRowsByIds(
  database: AtlasDatabase,
  edgeIds: readonly string[],
): StoredEdge[] {
  if (edgeIds.length === 0) return [];
  const uniqueIds = [...new Set(edgeIds)];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  return database
    .prepare(`SELECT ${EDGE_COLUMNS} FROM edges WHERE id IN (${placeholders}) ORDER BY id`)
    .all(...uniqueIds) as StoredEdge[];
}

export function queryEdges(
  database: AtlasDatabase,
  predicate: string,
  parameters: readonly unknown[],
): StoredEdge[] {
  return database
    .prepare(`SELECT ${EDGE_COLUMNS} FROM edges WHERE ${predicate} ORDER BY id`)
    .all(...parameters) as StoredEdge[];
}
