import type { ParsedFile } from "../parser/parser.js";
import type { AtlasDatabase } from "../storage/database.js";
import { createEdgeId, createNodeId } from "./ids.js";
import type { GraphEdge, GraphNode, NodeKind } from "./types.js";

interface StoredIdentityNode {
  id: string;
  kind: NodeKind;
  qualifiedName: string | null;
}

interface IdentityNodeRow {
  id: string;
  kind: NodeKind;
  qualified_name: string | null;
}

interface EdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: "RENAMED_FROM";
  source_type: "git";
  confidence: number;
  file_path: string | null;
  line: number | null;
  metadata_json: string | null;
}

export interface RenamePlan {
  previousPath: string;
  path: string;
  similarity: number;
  fileNodeId: string;
  parsedFile: ParsedFile;
  preservedNodeIds: Set<string>;
  removedNodeIds: string[];
  renameEdges: GraphEdge[];
}

function identityKey(kind: NodeKind, qualifiedName: string | null): string {
  return `${kind}\0${qualifiedName ?? ""}`;
}

function loadIdentityNodes(
  database: AtlasDatabase,
  filePath: string,
): StoredIdentityNode[] {
  return (
    database
      .prepare(
        `SELECT id, kind, qualified_name
         FROM nodes
         WHERE file_path = ?
         ORDER BY kind, qualified_name, id`,
      )
      .all(filePath) as IdentityNodeRow[]
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    qualifiedName: row.qualified_name,
  }));
}

function loadHistoricalRenameEdges(
  database: AtlasDatabase,
  filePath: string,
): GraphEdge[] {
  const rows = database
    .prepare(
      `SELECT edges.id, edges.source_node_id, edges.target_node_id,
              edges.edge_type, edges.source_type, edges.confidence,
              edges.file_path, edges.line, edges.metadata_json
       FROM edges
       JOIN nodes source ON source.id = edges.source_node_id
       WHERE edges.edge_type = 'RENAMED_FROM' AND source.file_path = ?
       ORDER BY edges.id`,
    )
    .all(filePath) as EdgeRow[];
  return rows.map((row) => ({
    id: row.id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    edgeType: row.edge_type,
    sourceType: row.source_type,
    confidence: row.confidence,
    filePath: row.file_path,
    line: row.line,
    metadata:
      row.metadata_json === null
        ? {}
        : (JSON.parse(row.metadata_json) as Record<string, unknown>),
  }));
}

export function loadRenamePathAliases(database: AtlasDatabase): Map<string, string> {
  const rows = database
    .prepare(
      `SELECT source.file_path AS current_path, edges.metadata_json
       FROM edges
       JOIN nodes source ON source.id = edges.source_node_id
       WHERE edges.edge_type = 'RENAMED_FROM' AND source.kind = 'file'
       ORDER BY edges.created_at, edges.id`,
    )
    .all() as Array<{ current_path: string; metadata_json: string | null }>;
  const aliases = new Map<string, string>();
  for (const row of rows) {
    if (row.metadata_json === null) continue;
    const metadata = JSON.parse(row.metadata_json) as { previous_path?: unknown };
    if (typeof metadata.previous_path === "string") {
      aliases.set(metadata.previous_path, row.current_path);
    }
  }
  return aliases;
}

function renamedFromEdge(
  repositoryId: string,
  node: Pick<GraphNode, "id" | "startLine" | "startColumn">,
  previousPath: string,
  currentPath: string,
  similarity: number,
): GraphEdge {
  const line = node.startLine ?? 1;
  return {
    id: createEdgeId(
      repositoryId,
      "RENAMED_FROM",
      node.id,
      node.id,
      previousPath,
      line,
    ),
    sourceNodeId: node.id,
    targetNodeId: node.id,
    edgeType: "RENAMED_FROM",
    sourceType: "git",
    confidence: 0.95,
    filePath: currentPath,
    line,
    metadata: {
      evidence: {
        source_type: "git",
        file: currentPath,
        line,
        column: node.startColumn ?? 0,
      },
      previous_path: previousPath,
      current_path: currentPath,
      git_similarity: similarity,
    },
  };
}

export function planGraphRename(
  database: AtlasDatabase,
  repositoryId: string,
  previousPath: string,
  currentPath: string,
  similarity: number,
  parsedFile: ParsedFile,
): RenamePlan {
  const oldNodes = loadIdentityNodes(database, previousPath);
  const historicalRenameEdges = loadHistoricalRenameEdges(database, previousPath);
  const oldByIdentity = new Map(
    oldNodes.map((node) => [identityKey(node.kind, node.qualifiedName), node]),
  );
  const newFileNodeId = createNodeId(repositoryId, "file", currentPath, currentPath);
  const oldFileNode = oldByIdentity.get(identityKey("file", previousPath));
  const fileNodeId = oldFileNode?.id ?? newFileNodeId;
  const nodeIdMap = new Map<string, string>([[newFileNodeId, fileNodeId]]);

  for (const node of parsedFile.nodes) {
    const previousQualifiedName =
      node.kind === "module" && node.qualifiedName === currentPath
        ? previousPath
        : node.qualifiedName;
    const previous = oldByIdentity.get(identityKey(node.kind, previousQualifiedName));
    if (previous !== undefined) nodeIdMap.set(node.id, previous.id);
  }

  const remappedNodes = parsedFile.nodes.map((node) => ({
    ...node,
    id: nodeIdMap.get(node.id) ?? node.id,
  }));
  const remappedEdges = parsedFile.edges.map((edge) => {
    const sourceNodeId = nodeIdMap.get(edge.sourceNodeId) ?? edge.sourceNodeId;
    const targetNodeId = nodeIdMap.get(edge.targetNodeId) ?? edge.targetNodeId;
    return {
      ...edge,
      id: createEdgeId(
        repositoryId,
        edge.edgeType,
        sourceNodeId,
        targetNodeId,
        currentPath,
        edge.line,
      ),
      sourceNodeId,
      targetNodeId,
      filePath: currentPath,
    };
  });
  const remappedReferences = parsedFile.unresolvedReferences.map((reference) => ({
    ...reference,
    sourceNodeId: nodeIdMap.get(reference.sourceNodeId) ?? reference.sourceNodeId,
  }));
  const preservedNodeIds = new Set(nodeIdMap.values());
  const removedNodeIds = oldNodes
    .map((node) => node.id)
    .filter((id) => !preservedNodeIds.has(id));
  const fileNode: Pick<GraphNode, "id" | "startLine" | "startColumn"> = {
    id: fileNodeId,
    startLine: 1,
    startColumn: 0,
  };
  const currentHistoricalEdges = historicalRenameEdges
    .filter(
      (edge) =>
        preservedNodeIds.has(edge.sourceNodeId) && preservedNodeIds.has(edge.targetNodeId),
    )
    .map((edge) => {
      const metadata = { ...edge.metadata };
      const evidence = metadata.evidence;
      metadata.evidence = {
        ...(typeof evidence === "object" && evidence !== null ? evidence : {}),
        source_type: "git",
        file: currentPath,
      };
      return { ...edge, filePath: currentPath, metadata };
    });
  const renameEdges = [
    ...currentHistoricalEdges,
    renamedFromEdge(
      repositoryId,
      fileNode,
      previousPath,
      currentPath,
      similarity,
    ),
    ...remappedNodes
      .filter((node) => preservedNodeIds.has(node.id))
      .map((node) =>
        renamedFromEdge(
          repositoryId,
          node,
          previousPath,
          currentPath,
          similarity,
        ),
      ),
  ];

  return {
    previousPath,
    path: currentPath,
    similarity,
    fileNodeId,
    parsedFile: {
      nodes: remappedNodes,
      edges: remappedEdges,
      unresolvedReferences: remappedReferences,
      errors: parsedFile.errors,
    },
    preservedNodeIds,
    removedNodeIds,
    renameEdges,
  };
}
