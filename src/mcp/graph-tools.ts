import { workspacePaths } from "../core/workspace.js";
import { sha256 } from "../core/hashing.js";
import type { EdgeType, NodeKind } from "../graph/types.js";
import { openDatabase, type AtlasDatabase } from "../storage/database.js";
import type { FreshContext } from "./freshness.js";
import {
  decodeCursor,
  encodeCursor,
  evidenceForNode,
  evidenceFrom,
  freshnessFor,
  getNodesByIds,
  listEdgesForNode,
  nodeFact,
  nodeFactWithTransientRoute,
  parseMetadata,
  queryEdges,
  relationshipsFromEdges,
  resolveTarget,
  sourceSnippetsForNodes,
  uncertaintiesForNodes,
  type StoredEdge,
  type StoredNode,
} from "./query.js";
import { answerPacketSchema, type AnswerPacket } from "./schemas.js";
import { rankEdges } from "./relevance.js";

interface PageInput {
  cursor?: string | null;
  limit: number;
}

interface SearchInput extends PageInput {
  query: string;
}

interface DependenciesInput extends PageInput {
  target: string;
  direction: "incoming" | "outgoing" | "both";
}

interface TraceInput extends PageInput {
  start: string;
  max_depth: number;
}

interface ImpactInput extends PageInput {
  target: string;
}

interface ExplainFeatureInput extends PageInput {
  feature: string;
}

const SEARCHABLE_KINDS: readonly NodeKind[] = [
  "file",
  "documentation",
  "class",
  "interface",
  "function",
  "method",
  "variable",
  "api_route",
  "database_model",
  "database_table",
  "external_service",
  "test",
  "feature",
  "domain",
];

const DEPENDENCY_EDGE_TYPES: readonly EdgeType[] = [
  "IMPORTS",
  "CALLS",
  "REFERENCES",
  "EXTENDS",
  "IMPLEMENTS",
  "DEPENDS_ON",
  "READS_FROM",
  "WRITES_TO",
  "HANDLES",
  "TRIGGERS",
  "PUBLISHES",
  "SUBSCRIBES",
  "TESTS",
  "CONFIGURES",
  "USES_EXTERNAL_SERVICE",
  "MOUNTS",
  "APPLIES_HOOK",
  "DECORATES",
  "IMPLEMENTED_BY",
  "PROTECTED_BY",
  "MAY_CONTINUE_TO",
  "ROUTE_PREFIX",
  "QUERIES",
  "UPDATES",
];

const TRACE_EDGE_TYPES: readonly EdgeType[] = [
  "HANDLES",
  "CALLS",
  "DEPENDS_ON",
  "IMPORTS",
  "READS_FROM",
  "WRITES_TO",
  "USES_EXTERNAL_SERVICE",
  "TRIGGERS",
  "PUBLISHES",
  "SUBSCRIBES",
  "REFERENCES",
  "MOUNTS",
  "APPLIES_HOOK",
  "DECORATES",
  "IMPLEMENTED_BY",
  "PROTECTED_BY",
  "MAY_CONTINUE_TO",
  "ROUTE_PREFIX",
  "QUERIES",
  "UPDATES",
];

const TRACE_EDGE_PRIORITY: Readonly<Record<EdgeType, number>> = {
  HANDLES: 100,
  PROTECTED_BY: 98,
  IMPLEMENTED_BY: 96,
  MAY_CONTINUE_TO: 94,
  CALLS: 92,
  QUERIES: 90,
  UPDATES: 90,
  PUBLISHES: 88,
  SUBSCRIBES: 88,
  TRIGGERS: 86,
  USES_EXTERNAL_SERVICE: 84,
  READS_FROM: 82,
  WRITES_TO: 82,
  APPLIES_HOOK: 80,
  MOUNTS: 78,
  DECORATES: 76,
  DEPENDS_ON: 70,
  REFERENCES: 50,
  IMPORTS: 40,
  ROUTE_PREFIX: 30,
  CONTAINS: 0,
  EXPORTS: 0,
  EXTENDS: 0,
  IMPLEMENTS: 0,
  EXPOSES: 0,
  TESTS: 0,
  BELONGS_TO_FEATURE: 0,
  BELONGS_TO_DOMAIN: 0,
  CONFIGURES: 0,
  RENAMED_FROM: 0,
};

const TRACE_EDGE_ORDER_SQL = `CASE edge_type ${TRACE_EDGE_TYPES
  .map((edgeType) => `WHEN '${edgeType}' THEN ${100 - TRACE_EDGE_PRIORITY[edgeType]}`)
  .join(" ")} ELSE 100 END`;

function packet(
  value: Omit<AnswerPacket, "freshness" | "security">,
  context: FreshContext,
): AnswerPacket {
  return answerPacketSchema.parse({ ...value, freshness: freshnessFor(context) });
}

function noTargetPacket(
  tool: string,
  topic: string,
  context: FreshContext,
  uncertainty: AnswerPacket["uncertainties"][number],
): AnswerPacket {
  return packet(
    {
      answer_context: { topic, tool },
      facts: [],
      relationships: [],
      source_snippets: [],
      uncertainties: [uncertainty],
      pagination: { cursor: null, has_more: false },
    },
    context,
  );
}

function withDatabase<T>(context: FreshContext, callback: (database: AtlasDatabase) => T): T {
  const database = openDatabase(workspacePaths(context.status.root).database, { readonly: true });
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "code", "does", "for", "how", "in", "is", "it",
  "of", "on", "show", "the", "this", "to", "what", "where", "which", "work", "works",
]);

function searchTerms(query: string): string[] {
  const raw = (query.toLowerCase().match(/[\p{L}\p{N}_$-]+/gu) ?? [])
    .filter((term) => term.length > 1);
  const meaningful = raw.filter((term) => !SEARCH_STOP_WORDS.has(term));
  return [...new Set(meaningful.length > 0 ? meaningful : raw)];
}

function searchExpression(query: string): string | null {
  const terms = searchTerms(query);
  if (terms.length === 0) return null;
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(" OR ");
}

function searchNodes(
  database: AtlasDatabase,
  query: string,
  limit: number,
  offset: number,
): StoredNode[] {
  const kinds = SEARCHABLE_KINDS.map(() => "?").join(", ");
  const expression = searchExpression(query);
  if (expression !== null) {
    return database
      .prepare(
        `SELECT
           nodes.id, nodes.kind, nodes.name,
           nodes.qualified_name AS qualifiedName, nodes.file_path AS filePath,
           nodes.language, nodes.start_line AS startLine,
           nodes.start_column AS startColumn, nodes.end_line AS endLine,
           nodes.end_column AS endColumn, nodes.signature, nodes.visibility,
           nodes.source_type AS sourceType,
           nodes.provenance_category AS provenance, nodes.confidence,
           nodes.metadata_json AS metadataJson
         FROM nodes_fts
         JOIN nodes ON nodes.rowid = nodes_fts.rowid
         WHERE nodes_fts MATCH ? AND nodes.kind IN (${kinds})
         ORDER BY
           CASE
             WHEN lower(nodes.name) = lower(?) THEN 0
             WHEN lower(coalesce(nodes.qualified_name, '')) = lower(?) THEN 1
             WHEN lower(nodes.name) LIKE lower(?) || '%' THEN 2
             WHEN instr(lower(coalesce(nodes.file_path, '')), lower(?)) > 0 THEN 3
             ELSE 4
           END,
           bm25(nodes_fts),
           nodes.confidence DESC, nodes.kind, nodes.name, nodes.id
         LIMIT ? OFFSET ?`,
      )
      .all(
        expression,
        ...SEARCHABLE_KINDS,
        query,
        query,
        query,
        query,
        limit,
        offset,
      ) as StoredNode[];
  }

  return database
    .prepare(
      `SELECT
         id, kind, name, qualified_name AS qualifiedName, file_path AS filePath,
         language, start_line AS startLine, start_column AS startColumn,
         end_line AS endLine, end_column AS endColumn, signature, visibility,
         source_type AS sourceType, provenance_category AS provenance,
         confidence, metadata_json AS metadataJson
       FROM nodes
       WHERE kind IN (${kinds})
         AND (instr(lower(name), lower(?)) > 0
           OR instr(lower(coalesce(qualified_name, '')), lower(?)) > 0
           OR instr(lower(coalesce(file_path, '')), lower(?)) > 0)
       ORDER BY kind, name, id
       LIMIT ? OFFSET ?`,
    )
    .all(...SEARCHABLE_KINDS, query, query, query, limit, offset) as StoredNode[];
}

function routePathFromQuery(query: string): string | null {
  return query.match(/\/[A-Za-z0-9_~!$&'()*+,;=:@%./{}-]*/u)?.[0] ?? null;
}

function routeNodesForLiteral(
  database: AtlasDatabase,
  routePath: string,
  limit: number,
  offset: number,
): StoredNode[] {
  return database
    .prepare(
      `SELECT
         id, kind, name, qualified_name AS qualifiedName, file_path AS filePath,
         language, start_line AS startLine, start_column AS startColumn,
         end_line AS endLine, end_column AS endColumn, signature, visibility,
         source_type AS sourceType, provenance_category AS provenance,
         confidence, metadata_json AS metadataJson
       FROM nodes
       WHERE kind = 'api_route'
         AND (
           json_extract(metadata_json, '$.route_path_hash') = ?
           OR id IN (
             SELECT target_node_id FROM edges
             WHERE edge_type = 'ROUTE_PREFIX'
               AND json_extract(metadata_json, '$.effective_route_path_hash') = ?
           )
         )
       ORDER BY json_extract(metadata_json, '$.http_method'), file_path, start_line, id
       LIMIT ? OFFSET ?`,
    )
    .all(
      sha256(`route:${routePath}`),
      sha256(`route:${routePath}`),
      limit,
      offset,
    ) as StoredNode[];
}

export function searchPacket(context: FreshContext, input: SearchInput): AnswerPacket {
  return withDatabase(context, (database) => {
    const scope = input.query.trim().toLowerCase();
    const offset = decodeCursor(input.cursor, "search", scope);
    const pageSize = Math.min(input.limit, context.config.limits.maxMcpResultNodes);
    const routePath = routePathFromQuery(input.query);
    const exactRouteRows = routePath === null
      ? []
      : routeNodesForLiteral(database, routePath, pageSize + 1, offset);
    const rows = exactRouteRows.length > 0
      ? exactRouteRows
      : searchNodes(database, input.query, pageSize + 1, offset);
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const uncertainties: AnswerPacket["uncertainties"] = [];
    if (page.length === 0) {
      uncertainties.push({
        description: `CodeAtlas found no indexed graph nodes matching ${JSON.stringify(input.query)}.`,
        reason: "insufficient_evidence",
        candidates: [],
      });
    }
    const heuristic = page.filter((node) => node.sourceType === "heuristic");
    if (heuristic.length > 0) {
      uncertainties.push({
        description: "Some search results are heuristic architecture groups.",
        reason: "heuristic_only",
        candidates: heuristic.map((node) => node.id),
      });
    }
    const effectivePrefixEdges = routePath === null || page.length === 0
      ? []
      : queryEdges(
          database,
          `edge_type = 'ROUTE_PREFIX'
           AND json_extract(metadata_json, '$.effective_route_path_hash') = ?
           AND target_node_id IN (${page.map(() => "?").join(", ")})`,
          [sha256(`route:${routePath}`), ...page.map((node) => node.id)],
          pageSize,
        );
    const prefixByRoute = new Map(
      effectivePrefixEdges.map((edge) => [edge.targetNodeId, edge]),
    );
    return packet(
      {
        answer_context: { topic: input.query, tool: "codeatlas_search" },
        facts: page.map((node) => {
          const prefix = prefixByRoute.get(node.id);
          if (prefix === undefined || routePath === null) {
            return nodeFactWithTransientRoute(context.status.root, node, "Search result");
          }
          const method = parseMetadata(node.metadataJson).http_method;
          return {
            statement: `Search result verified effective route ${typeof method === "string" ? method : "HTTP"} ${routePath} (${node.name}) [node_id: ${node.id}].`,
            confidence: Math.min(node.confidence, prefix.confidence),
            source_type: prefix.sourceType,
            provenance: prefix.provenance,
            evidence: evidenceFrom(
              parseMetadata(prefix.metadataJson),
              prefix.filePath,
              prefix.line,
            ),
          };
        }),
        relationships: relationshipsFromEdges(database, effectivePrefixEdges),
        source_snippets: sourceSnippetsForNodes(context.status.root, page, {
          maxSnippets: 6,
          maxLines: Math.min(10, context.config.limits.maxSourceSnippetLines),
          maxBytes: context.config.limits.maxSourceSnippetBytes,
        }),
        uncertainties,
        pagination: {
          cursor: hasMore ? encodeCursor(offset + pageSize, "search", scope) : null,
          has_more: hasMore,
        },
      },
      context,
    );
  });
}

function descriptiveFacts(repositoryRoot: string, node: StoredNode): AnswerPacket["facts"] {
  const facts = [nodeFactWithTransientRoute(repositoryRoot, node)];
  const details = [
    node.language === null ? null : `language ${node.language}`,
    node.visibility === null ? null : `visibility ${node.visibility}`,
    node.signature === null ? null : `signature ${node.signature}`,
  ].filter((value): value is string => value !== null);
  if (details.length > 0) {
    facts.push({
      statement: `${node.name} has ${details.join(", ")}.`,
      confidence: node.confidence,
      source_type: node.sourceType,
      provenance: node.provenance,
      evidence: evidenceForNode(node),
    });
  }
  return facts;
}

export function getNodePacket(
  context: FreshContext,
  input: { node_id: string },
): AnswerPacket {
  return withDatabase(context, (database) => {
    const resolution = resolveTarget(database, input.node_id);
    if (resolution.node === null) {
      return noTargetPacket(
        "codeatlas_get_node",
        input.node_id,
        context,
        resolution.uncertainty!,
      );
    }
    const edgeRows = listEdgesForNode(
      database,
      resolution.node.id,
      "both",
      context.config.limits.maxMcpResultNodes + 1,
    );
    const truncated = edgeRows.length > context.config.limits.maxMcpResultNodes;
    const selectedEdges = rankEdges(
      database,
      edgeRows.slice(0, context.config.limits.maxMcpResultNodes),
      resolution.node.id,
    );
    const uncertainties = uncertaintiesForNodes(
      database,
      [resolution.node.id],
      context.config.limits.maxMcpResultNodes,
    );
    if (truncated) {
      uncertainties.push({
        description: "The node has more relationships than the configured MCP result limit.",
        reason: "insufficient_evidence",
        candidates: [],
      });
    }
    if (resolution.node.sourceType === "heuristic") {
      uncertainties.push({
        description: "This node is an inferred architecture group.",
        reason: "heuristic_only",
        candidates: [resolution.node.id],
      });
    }
    return packet(
      {
        answer_context: { topic: resolution.node.name, tool: "codeatlas_get_node" },
        facts: descriptiveFacts(context.status.root, resolution.node),
        relationships: relationshipsFromEdges(database, selectedEdges),
        source_snippets: sourceSnippetsForNodes(context.status.root, [resolution.node], {
          maxSnippets: 1,
          maxLines: Math.min(12, context.config.limits.maxSourceSnippetLines),
          maxBytes: context.config.limits.maxSourceSnippetBytes,
        }),
        uncertainties,
        pagination: { cursor: null, has_more: false },
      },
      context,
    );
  });
}

function relatedNodeIds(edges: readonly StoredEdge[], targetId: string): string[] {
  return edges.map((edge) =>
    edge.sourceNodeId === targetId ? edge.targetNodeId : edge.sourceNodeId,
  );
}

export function dependenciesPacket(
  context: FreshContext,
  input: DependenciesInput,
): AnswerPacket {
  return withDatabase(context, (database) => {
    const resolution = resolveTarget(database, input.target);
    if (resolution.node === null) {
      return noTargetPacket(
        "codeatlas_dependencies",
        input.target,
        context,
        resolution.uncertainty!,
      );
    }
    const scope = `${resolution.node.id}:${input.direction}`;
    const offset = decodeCursor(input.cursor, "dependencies", scope);
    const pageSize = Math.min(input.limit, context.config.limits.maxMcpResultNodes);
    const rows = listEdgesForNode(
      database,
      resolution.node.id,
      input.direction,
      pageSize + 1,
      offset,
      DEPENDENCY_EDGE_TYPES,
    );
    const hasMore = rows.length > pageSize;
    const page = rankEdges(database, rows.slice(0, pageSize), resolution.node.id);
    const related = getNodesByIds(database, relatedNodeIds(page, resolution.node.id));
    const uncertainties = uncertaintiesForNodes(
      database,
      [resolution.node.id, ...related.map((node) => node.id)],
      context.config.limits.maxMcpResultNodes,
    );
    if (page.length === 0) {
      uncertainties.push({
        description: `No ${input.direction} relationships were verified for ${resolution.node.name}.`,
        reason: "insufficient_evidence",
        candidates: [],
      });
    }
    return packet(
      {
        answer_context: {
          topic: `${resolution.node.name} dependencies`,
          tool: "codeatlas_dependencies",
        },
        facts: [
          nodeFactWithTransientRoute(context.status.root, resolution.node, "Dependency target"),
          ...related.map((node) =>
            nodeFactWithTransientRoute(context.status.root, node, "Related node"),
          ),
        ],
        relationships: relationshipsFromEdges(database, page),
        source_snippets: sourceSnippetsForNodes(
          context.status.root,
          [resolution.node, ...related],
          {
            maxSnippets: 6,
            maxLines: Math.min(10, context.config.limits.maxSourceSnippetLines),
            maxBytes: context.config.limits.maxSourceSnippetBytes,
          },
        ),
        uncertainties,
        pagination: {
          cursor: hasMore
            ? encodeCursor(offset + pageSize, "dependencies", scope)
            : null,
          has_more: hasMore,
        },
      },
      context,
    );
  });
}

interface TraversalItem {
  edge: StoredEdge;
  depth: number;
  confidence: number;
  deterministic: boolean;
}

interface TraversalResult {
  items: TraversalItem[];
  nodeIds: string[];
  truncated: boolean;
}

function traverse(
  database: AtlasDatabase,
  startNodeId: string,
  direction: "incoming" | "outgoing",
  edgeTypes: readonly EdgeType[],
  maxDepth: number,
  maxNodes: number,
): TraversalResult {
  const edgePlaceholders = edgeTypes.map(() => "?").join(", ");
  type TraversalState = {
    nodeId: string;
    depth: number;
    confidence: number;
    deterministic: boolean;
  };
  let frontier: TraversalState[] = [
    { nodeId: startNodeId, depth: 0, confidence: 1, deterministic: true },
  ];
  const visitedDepth = new Map<string, number>([[startNodeId, 0]]);
  const seenEdges = new Set<string>();
  const items: TraversalItem[] = [];
  let truncated = false;

  while (frontier.length > 0 && items.length < maxNodes) {
    const active = frontier.filter((state) => state.depth < maxDepth);
    if (active.length === 0) break;
    const stateByNodeId = new Map(active.map((state) => [state.nodeId, state]));
    const nodePlaceholders = active.map(() => "?").join(", ");
    const column = direction === "outgoing" ? "source_node_id" : "target_node_id";
    const remaining = maxNodes - items.length;
    const edgeRows = database
      .prepare(
        `SELECT
           id, source_node_id AS sourceNodeId, target_node_id AS targetNodeId,
           edge_type AS edgeType, source_type AS sourceType,
           provenance_category AS provenance, confidence,
           file_path AS filePath, line, metadata_json AS metadataJson
         FROM edges
         WHERE ${column} IN (${nodePlaceholders})
           AND edge_type IN (${edgePlaceholders})
         ORDER BY edge_type, source_node_id, target_node_id, id
         LIMIT ?`,
      )
      .all(...active.map((state) => state.nodeId), ...edgeTypes, remaining + 1) as StoredEdge[];
    if (edgeRows.length > remaining) truncated = true;
    const nextFrontier = new Map<string, TraversalState>();

    for (const edge of edgeRows.slice(0, remaining)) {
      if (seenEdges.has(edge.id)) continue;
      const currentNodeId = direction === "outgoing" ? edge.sourceNodeId : edge.targetNodeId;
      const current = stateByNodeId.get(currentNodeId);
      if (current === undefined) continue;
      seenEdges.add(edge.id);
      const nextNodeId = direction === "outgoing" ? edge.targetNodeId : edge.sourceNodeId;
      const depth = current.depth + 1;
      const confidence = Math.min(current.confidence, edge.confidence);
      const deterministic =
        current.deterministic && edge.sourceType !== "heuristic" && edge.confidence === 1;
      items.push({ edge, depth, confidence, deterministic });
      if (visitedDepth.size >= maxNodes) {
        truncated = true;
        continue;
      }
      const previousDepth = visitedDepth.get(nextNodeId);
      if (previousDepth === undefined || depth < previousDepth) {
        visitedDepth.set(nextNodeId, depth);
        nextFrontier.set(nextNodeId, { nodeId: nextNodeId, depth, confidence, deterministic });
      }
    }
    frontier = [...nextFrontier.values()];
  }
  if (items.length >= maxNodes && frontier.length > 0) truncated = true;
  return { items, nodeIds: [...visitedDepth.keys()], truncated };
}

function traceTraverse(
  database: AtlasDatabase,
  startNodeId: string,
  maxDepth: number,
  maxNodes: number,
  maxPaths: number,
): TraversalResult {
  interface PathState {
    nodeId: string;
    depth: number;
    confidence: number;
    deterministic: boolean;
    visited: Set<string>;
    priority: number;
  }

  const edgePlaceholders = TRACE_EDGE_TYPES.map(() => "?").join(", ");
  const queue: PathState[] = [{
    nodeId: startNodeId,
    depth: 0,
    confidence: 1,
    deterministic: true,
    visited: new Set([startNodeId]),
    priority: Number.MAX_SAFE_INTEGER,
  }];
  const items = new Map<string, TraversalItem>();
  const visitedNodes = new Set<string>([startNodeId]);
  const adjacency = new Map<string, StoredEdge[]>();
  let completedPaths = 0;
  let truncated = false;

  while (queue.length > 0 && completedPaths < maxPaths && visitedNodes.size <= maxNodes) {
    queue.sort(
      (left, right) =>
        right.priority - left.priority ||
        left.depth - right.depth ||
        left.nodeId.localeCompare(right.nodeId),
    );
    const current = queue.shift()!;
    if (current.depth >= maxDepth) {
      completedPaths += 1;
      continue;
    }
    if (!adjacency.has(current.nodeId)) {
      const pendingNodeIds = [...new Set([current, ...queue]
        .map((state) => state.nodeId)
        .filter((nodeId) => !adjacency.has(nodeId)))];
      const nodePlaceholders = pendingNodeIds.map(() => "?").join(", ");
      const outgoingRows = database
        .prepare(
          `WITH ranked_edges AS (
             SELECT
               id, source_node_id AS sourceNodeId, target_node_id AS targetNodeId,
               edge_type AS edgeType, source_type AS sourceType,
               provenance_category AS provenance, confidence,
               file_path AS filePath, line, metadata_json AS metadataJson,
               row_number() OVER (
                 PARTITION BY source_node_id
                 ORDER BY ${TRACE_EDGE_ORDER_SQL}, confidence DESC, target_node_id, id
               ) AS edgeRank
             FROM edges
             WHERE source_node_id IN (${nodePlaceholders})
               AND edge_type IN (${edgePlaceholders})
           )
           SELECT id, sourceNodeId, targetNodeId, edgeType, sourceType, provenance,
                  confidence, filePath, line, metadataJson
           FROM ranked_edges
           WHERE edgeRank <= ?
           ORDER BY sourceNodeId, edgeRank, targetNodeId, id`,
        )
        .all(...pendingNodeIds, ...TRACE_EDGE_TYPES, maxNodes) as StoredEdge[];
      for (const nodeId of pendingNodeIds) adjacency.set(nodeId, []);
      for (const edge of outgoingRows) adjacency.get(edge.sourceNodeId)!.push(edge);
    }
    const outgoing = adjacency.get(current.nodeId) ?? [];
    const nextEdges = outgoing.filter((edge) => !current.visited.has(edge.targetNodeId));
    if (nextEdges.length === 0) {
      completedPaths += 1;
      continue;
    }

    let scheduled = 0;
    for (const edge of nextEdges) {
      if (completedPaths + queue.length >= maxPaths || visitedNodes.size >= maxNodes) {
        truncated = true;
        break;
      }
      const confidence = Math.min(current.confidence, edge.confidence);
      const deterministic =
        current.deterministic && edge.sourceType !== "heuristic" && edge.confidence === 1;
      const item = { edge, depth: current.depth + 1, confidence, deterministic };
      const existing = items.get(edge.id);
      if (existing === undefined || item.depth < existing.depth) items.set(edge.id, item);
      visitedNodes.add(edge.targetNodeId);
      queue.push({
        nodeId: edge.targetNodeId,
        depth: item.depth,
        confidence,
        deterministic,
        visited: new Set([...current.visited, edge.targetNodeId]),
        priority:
          TRACE_EDGE_PRIORITY[edge.edgeType] * 1_000 +
          confidence * 100 -
          item.depth,
      });
      scheduled += 1;
    }
    if (scheduled === 0) completedPaths += 1;
  }
  if (queue.length > 0) truncated = true;
  return { items: [...items.values()], nodeIds: [...visitedNodes], truncated };
}

function traversalUncertainties(
  database: AtlasDatabase,
  result: TraversalResult,
  maxResults: number,
  relevantNodeIds: readonly string[] = result.nodeIds,
): AnswerPacket["uncertainties"] {
  const uncertainties = uncertaintiesForNodes(database, relevantNodeIds, maxResults);
  const heuristicEdges = result.items
    .filter((item) => item.edge.sourceType === "heuristic" || item.edge.confidence < 1)
    .flatMap((item) => [item.edge.sourceNodeId, item.edge.targetNodeId]);
  if (heuristicEdges.length > 0) {
    uncertainties.push({
      description: "Some traversal hops are inferred or ambiguous and have reduced confidence.",
      reason: "heuristic_only",
      candidates: [...new Set(heuristicEdges)],
    });
  }
  if (result.truncated) {
    uncertainties.push({
      description: "Traversal stopped at the configured maximum returned-node limit.",
      reason: "insufficient_evidence",
      candidates: [],
    });
  }
  return uncertainties;
}

export function tracePacket(context: FreshContext, input: TraceInput): AnswerPacket {
  return withDatabase(context, (database) => {
    const resolution = resolveTarget(database, input.start);
    if (resolution.node === null) {
      return noTargetPacket("codeatlas_trace", input.start, context, resolution.uncertainty!);
    }
    const result = traceTraverse(
      database,
      resolution.node.id,
      input.max_depth,
      context.config.limits.maxMcpResultNodes,
      context.config.limits.maxExecutionPaths,
    );
    const distanceByNodeId = new Map<string, number>();
    for (const item of result.items) {
      distanceByNodeId.set(
        item.edge.targetNodeId,
        Math.min(distanceByNodeId.get(item.edge.targetNodeId) ?? item.depth, item.depth),
      );
    }
    const rankedEdges = rankEdges(
      database,
      result.items.map((item) => item.edge),
      resolution.node.id,
      distanceByNodeId,
    );
    const edgeRank = new Map(rankedEdges.map((edge, index) => [edge.id, index]));
    const rankedItems = [...result.items].sort(
      (left, right) =>
        (edgeRank.get(left.edge.id) ?? Number.MAX_SAFE_INTEGER) -
          (edgeRank.get(right.edge.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.depth - right.depth,
    );
    const scope = `${resolution.node.id}:${input.max_depth}`;
    const offset = decodeCursor(input.cursor, "trace", scope);
    const hasMore = rankedItems.length > offset + input.limit;
    const page = rankedItems.slice(offset, offset + input.limit);
    const reachedIds = page.map((item) => item.edge.targetNodeId);
    const reached = new Map(getNodesByIds(database, reachedIds).map((node) => [node.id, node]));
    const facts: AnswerPacket["facts"] = [
      nodeFactWithTransientRoute(context.status.root, resolution.node, "Trace start"),
    ];
    for (const item of page) {
      const node = reached.get(item.edge.targetNodeId);
      if (node === undefined) continue;
      facts.push({
        statement: `Trace depth ${item.depth} reaches ${node.kind} ${node.name}.`,
        confidence: item.confidence,
        source_type: item.edge.sourceType,
        provenance: item.edge.provenance,
        evidence: evidenceFrom(parseMetadata(item.edge.metadataJson), item.edge.filePath, item.edge.line),
      });
    }
    const uncertainties = traversalUncertainties(
      database,
      result,
      context.config.limits.maxMcpResultNodes,
      [resolution.node.id, ...reachedIds],
    );
    if (result.items.length === 0) {
      uncertainties.push({
        description: `No evidence-bearing execution or dependency path starts at ${resolution.node.name}.`,
        reason: "insufficient_evidence",
        candidates: [],
      });
    }
    return packet(
      {
        answer_context: { topic: resolution.node.name, tool: "codeatlas_trace" },
        facts,
        relationships: relationshipsFromEdges(database, page.map((item) => item.edge)),
        source_snippets: sourceSnippetsForNodes(
          context.status.root,
          [resolution.node, ...reached.values()],
          {
            maxSnippets: 8,
            maxLines: Math.min(10, context.config.limits.maxSourceSnippetLines),
            maxBytes: context.config.limits.maxSourceSnippetBytes,
          },
        ),
        uncertainties,
        pagination: {
          cursor: hasMore ? encodeCursor(offset + input.limit, "trace", scope) : null,
          has_more: hasMore,
        },
      },
      context,
    );
  });
}

export function impactPacket(context: FreshContext, input: ImpactInput): AnswerPacket {
  return withDatabase(context, (database) => {
    const resolution = resolveTarget(database, input.target);
    if (resolution.node === null) {
      return noTargetPacket("codeatlas_impact", input.target, context, resolution.uncertainty!);
    }
    const result = traverse(
      database,
      resolution.node.id,
      "incoming",
      DEPENDENCY_EDGE_TYPES,
      context.config.limits.maxTraversalDepth,
      context.config.limits.maxMcpResultNodes,
    );
    const membershipEdges = result.nodeIds.length === 0
      ? []
      : queryEdges(
          database,
          `source_node_id IN (${result.nodeIds.map(() => "?").join(", ")})
           AND edge_type = 'BELONGS_TO_FEATURE'`,
          result.nodeIds,
          context.config.limits.maxMcpResultNodes,
        );
    const combined: TraversalItem[] = [
      ...result.items,
      ...membershipEdges.map((edge) => ({
        edge,
        depth: 1,
        confidence: edge.confidence,
        deterministic: false,
      })),
    ];
    const distanceByNodeId = new Map<string, number>();
    for (const item of combined) {
      const relatedId = item.edge.edgeType === "BELONGS_TO_FEATURE"
        ? item.edge.targetNodeId
        : item.edge.sourceNodeId;
      distanceByNodeId.set(
        relatedId,
        Math.min(distanceByNodeId.get(relatedId) ?? item.depth, item.depth),
      );
    }
    const rankedEdges = rankEdges(
      database,
      combined.map((item) => item.edge),
      resolution.node.id,
      distanceByNodeId,
    );
    const edgeRank = new Map(rankedEdges.map((edge, index) => [edge.id, index]));
    combined.sort(
      (left, right) =>
        (edgeRank.get(left.edge.id) ?? Number.MAX_SAFE_INTEGER) -
        (edgeRank.get(right.edge.id) ?? Number.MAX_SAFE_INTEGER),
    );
    const scope = resolution.node.id;
    const offset = decodeCursor(input.cursor, "impact", scope);
    const hasMore = combined.length > offset + input.limit;
    const page = combined.slice(offset, offset + input.limit);
    const affectedIds = page.map((item) => item.edge.edgeType === "BELONGS_TO_FEATURE"
      ? item.edge.targetNodeId
      : item.edge.sourceNodeId);
    const affected = new Map(getNodesByIds(database, affectedIds).map((node) => [node.id, node]));
    const facts: AnswerPacket["facts"] = [
      nodeFactWithTransientRoute(context.status.root, resolution.node, "Impact target"),
    ];
    for (const item of page) {
      const relatedId = item.edge.edgeType === "BELONGS_TO_FEATURE"
        ? item.edge.targetNodeId
        : item.edge.sourceNodeId;
      const node = affected.get(relatedId);
      if (node === undefined) continue;
      const classification = item.deterministic ? "Definitely affected" : "Potentially affected";
      const distance = item.depth === 1 ? "direct" : `transitive depth ${item.depth}`;
      facts.push({
        statement: `${classification}: ${node.kind} ${node.name} (${distance}).`,
        confidence: item.confidence,
        source_type: item.edge.sourceType,
        provenance: item.edge.provenance,
        evidence: evidenceFrom(parseMetadata(item.edge.metadataJson), item.edge.filePath, item.edge.line),
      });
    }
    const uncertainties = traversalUncertainties(
      database,
      result,
      context.config.limits.maxMcpResultNodes,
      [resolution.node.id, ...affectedIds],
    );
    if (combined.length === 0) {
      uncertainties.push({
        description: `No direct or transitive dependents were verified for ${resolution.node.name}.`,
        reason: "insufficient_evidence",
        candidates: [],
      });
    }
    return packet(
      {
        answer_context: { topic: resolution.node.name, tool: "codeatlas_impact" },
        facts,
        relationships: relationshipsFromEdges(database, page.map((item) => item.edge)),
        source_snippets: sourceSnippetsForNodes(
          context.status.root,
          [resolution.node, ...affected.values()],
          {
            maxSnippets: 8,
            maxLines: Math.min(10, context.config.limits.maxSourceSnippetLines),
            maxBytes: context.config.limits.maxSourceSnippetBytes,
          },
        ),
        uncertainties,
        pagination: {
          cursor: hasMore ? encodeCursor(offset + input.limit, "impact", scope) : null,
          has_more: hasMore,
        },
      },
      context,
    );
  });
}

function featureMemberFacts(
  repositoryRoot: string,
  nodes: readonly StoredNode[],
): AnswerPacket["facts"] {
  return nodes.map((node) => {
    const role = node.kind === "api_route"
      ? "Entrypoint"
      : node.kind === "database_model" || node.kind === "database_table"
        ? "Database dependency"
        : node.kind === "external_service"
          ? "External dependency"
          : "Component";
    return nodeFactWithTransientRoute(repositoryRoot, node, role);
  });
}

export function explainFeaturePacket(
  context: FreshContext,
  input: ExplainFeatureInput,
): AnswerPacket {
  return withDatabase(context, (database) => {
    const resolution = resolveTarget(database, input.feature, ["feature"]);
    if (resolution.node === null) {
      return noTargetPacket(
        "codeatlas_explain_feature",
        input.feature,
        context,
        resolution.uncertainty!,
      );
    }
    const scope = resolution.node.id;
    const offset = decodeCursor(input.cursor, "explain-feature", scope);
    const pageSize = Math.min(input.limit, context.config.limits.maxMcpResultNodes);
    const memberships = database
      .prepare(
        `SELECT
           id, source_node_id AS sourceNodeId, target_node_id AS targetNodeId,
           edge_type AS edgeType, source_type AS sourceType,
           provenance_category AS provenance, confidence,
           file_path AS filePath, line, metadata_json AS metadataJson
         FROM edges
         WHERE target_node_id = ? AND edge_type = 'BELONGS_TO_FEATURE'
         ORDER BY source_node_id, id
         LIMIT ? OFFSET ?`,
      )
      .all(
        resolution.node.id,
        pageSize + 1,
        offset,
      ) as StoredEdge[];
    const hasMore = memberships.length > pageSize;
    const page = rankEdges(
      database,
      memberships.slice(0, pageSize),
      resolution.node.id,
    );
    const members = getNodesByIds(database, page.map((edge) => edge.sourceNodeId));
    const memberIds = members.map((node) => node.id);
    const remainingRelationshipBudget = Math.max(
      0,
      context.config.limits.maxMcpResultNodes - page.length,
    );
    const executionEdges = memberIds.length === 0 || remainingRelationshipBudget === 0
      ? []
      : queryEdges(
          database,
          `source_node_id IN (${memberIds.map(() => "?").join(", ")})
           AND edge_type IN (${TRACE_EDGE_TYPES.map(() => "?").join(", ")})`,
          [...memberIds, ...TRACE_EDGE_TYPES],
          remainingRelationshipBudget,
        );
    const uncertainties = uncertaintiesForNodes(
      database,
      memberIds,
      context.config.limits.maxMcpResultNodes,
    );
    uncertainties.push({
      description: "Feature membership is inferred from directory and dependency signals.",
      reason: "heuristic_only",
      candidates: [resolution.node.id, ...memberIds],
    });
    return packet(
      {
        answer_context: {
          topic: resolution.node.name,
          tool: "codeatlas_explain_feature",
        },
        facts: [
          nodeFact(resolution.node, "Feature"),
          ...featureMemberFacts(context.status.root, members),
        ],
        relationships: relationshipsFromEdges(database, [...page, ...executionEdges]),
        source_snippets: sourceSnippetsForNodes(context.status.root, members, {
          maxSnippets: 8,
          maxLines: Math.min(10, context.config.limits.maxSourceSnippetLines),
          maxBytes: context.config.limits.maxSourceSnippetBytes,
        }),
        uncertainties,
        pagination: {
          cursor: hasMore
            ? encodeCursor(offset + pageSize, "explain-feature", scope)
            : null,
          has_more: hasMore,
        },
      },
      context,
    );
  });
}
