import { createEdgeId } from "../graph/ids.js";
import { sha256 } from "../core/hashing.js";
import { isPathInside } from "../core/paths.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { EdgeType, GraphEdge, ProvenanceCategory, SourceType } from "../graph/types.js";
import type { AtlasDatabase } from "../storage/database.js";
import { upsertEdge } from "../storage/edges.js";

interface EdgeRow {
  source_node_id: string;
  target_node_id: string;
  edge_type: EdgeType;
  source_type: SourceType;
  provenance_category: ProvenanceCategory;
  confidence: number;
  file_path: string | null;
  line: number | null;
  metadata_json: string | null;
}

interface NodeRow {
  id: string;
  file_path: string | null;
  start_line: number | null;
  metadata_json: string | null;
}

function literalForHash(
  repositoryRoot: string,
  node: NodeRow,
  hashKind: string,
  expectedHash: string,
): string | null {
  if (node.file_path === null) return null;
  const sourcePath = path.resolve(repositoryRoot, ...node.file_path.split("/"));
  if (!isPathInside(repositoryRoot, sourcePath)) return null;
  let source: string;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch {
    return null;
  }
  for (const match of source.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/gsu)) {
    const value = (match[2] ?? "").replace(/\\([\\"'`])/gu, "$1");
    if (sha256(`${hashKind}:${value}`) === expectedHash) return value;
  }
  return null;
}

function effectiveRoutePath(prefix: string, routePath: string): string {
  const left = prefix === "/" ? "" : prefix.replace(/\/$/u, "");
  const right = routePath === "/" ? "" : routePath.replace(/^\//u, "");
  const combined = `${left}/${right}`.replace(/\/{2,}/gu, "/");
  return combined === "" ? "/" : combined.startsWith("/") ? combined : `/${combined}`;
}

function metadata(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function derivedEdge(
  repositoryId: string,
  input: {
    edgeType: EdgeType;
    sourceNodeId: string;
    targetNodeId: string;
    evidence: EdgeRow | NodeRow;
    relationship: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  },
): GraphEdge {
  const filePath = "file_path" in input.evidence ? input.evidence.file_path : null;
  const line = "line" in input.evidence
    ? input.evidence.line
    : input.evidence.start_line;
  return {
    id: createEdgeId(
      repositoryId,
      input.edgeType,
      input.sourceNodeId,
      input.targetNodeId,
      filePath ?? "",
      line,
    ),
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    edgeType: input.edgeType,
    sourceType: "framework",
    provenance: "verified",
    confidence: input.confidence ?? 1,
    filePath,
    line,
    metadata: {
      evidence: {
        source_type: "framework",
        file: filePath ?? ".",
        line: line ?? 1,
        column: 0,
      },
      framework: "fastify",
      relationship: input.relationship,
      derived_from_verified_framework_edges: true,
      ...(input.metadata ?? {}),
    },
  };
}

function outgoingEdges(
  database: AtlasDatabase,
  sourceNodeId: string,
  edgeType: EdgeType,
): EdgeRow[] {
  return database
    .prepare(
      `SELECT source_node_id, target_node_id, edge_type, source_type,
              provenance_category, confidence, file_path, line, metadata_json
       FROM edges
       WHERE source_node_id = ? AND edge_type = ?
       ORDER BY target_node_id, id`,
    )
    .all(sourceNodeId, edgeType) as EdgeRow[];
}

interface MountedRoute {
  routeId: string;
  registrationPath: string[];
}

function mountedRoutes(database: AtlasDatabase, pluginNodeId: string): MountedRoute[] {
  const routes = new Map<string, MountedRoute>();
  const visitedStates = new Set<string>();
  const queue = [{ pluginId: pluginNodeId, registrationPath: [] as string[] }];
  for (let head = 0; head < queue.length && visitedStates.size < 1_000; head += 1) {
    const state = queue[head]!;
    const stateKey = `${state.pluginId}\0${state.registrationPath.join("\0")}`;
    if (visitedStates.has(stateKey)) continue;
    visitedStates.add(stateKey);
    const exposed = database
      .prepare(
        `SELECT edges.target_node_id AS id, nodes.kind
         FROM edges
         JOIN nodes ON nodes.id = edges.target_node_id
         WHERE edges.source_node_id = ? AND edges.edge_type = 'EXPOSES'
         ORDER BY edges.target_node_id`,
      )
      .all(state.pluginId) as Array<{ id: string; kind: string }>;
    for (const row of exposed) {
      if (row.kind === "api_route") {
        const key = `${row.id}\0${state.registrationPath.join("\0")}`;
        routes.set(key, { routeId: row.id, registrationPath: state.registrationPath });
      }
    }
    const childPlugins = database
      .prepare(
        `SELECT registration.id AS registration_id, mounts.target_node_id AS id
         FROM edges ownership
         JOIN nodes registration ON registration.id = ownership.target_node_id
         JOIN edges mounts
           ON mounts.source_node_id = registration.id AND mounts.edge_type = 'MOUNTS'
         WHERE ownership.source_node_id = ?
           AND ownership.edge_type = 'CONFIGURES'
           AND json_extract(registration.metadata_json, '$.fastify_entity') = 'registration'
         ORDER BY mounts.target_node_id`,
      )
      .all(state.pluginId) as Array<{ registration_id: string; id: string }>;
    for (const child of childPlugins) {
      queue.push({
        pluginId: child.id,
        registrationPath: [...state.registrationPath, child.registration_id],
      });
    }
  }
  return [...routes.values()].sort(
    (left, right) =>
      left.routeId.localeCompare(right.routeId) ||
      left.registrationPath.join("\0").localeCompare(right.registrationPath.join("\0")),
  );
}

function routesMountedBy(database: AtlasDatabase, pluginNodeId: string): string[] {
  return [...new Set(mountedRoutes(database, pluginNodeId).map((route) => route.routeId))]
    .sort((left, right) => left.localeCompare(right));
}

function hookImplementations(database: AtlasDatabase, hookNodeId: string): string[] {
  const implementations = outgoingEdges(database, hookNodeId, "IMPLEMENTED_BY")
    .map((edge) => edge.target_node_id);
  return implementations.length === 0 ? [hookNodeId] : implementations;
}

/** Materializes deterministic Fastify composition edges after symbol resolution. */
export function materializeFrameworkRelationships(
  database: AtlasDatabase,
  repositoryId: string,
  repositoryRoot: string,
  timestamp: string,
): number {
  // Derived composition edges depend on several independently resolved edges.
  // Rebuild this small projection so a removed mount or hook cannot leave stale
  // route protection/continuation relationships behind.
  database
    .prepare(
      `DELETE FROM edges
       WHERE source_type = 'framework'
         AND json_extract(metadata_json, '$.derived_from_verified_framework_edges') = 1`,
    )
    .run();

  const written = new Set<string>();
  const write = (edge: GraphEdge): void => {
    upsertEdge(database, edge, timestamp);
    written.add(edge.id);
  };

  const decorators = database
    .prepare(
      `SELECT id, file_path, start_line, metadata_json
       FROM nodes
       WHERE kind = 'configuration'
         AND json_extract(metadata_json, '$.framework') = 'fastify'
         AND json_extract(metadata_json, '$.fastify_entity') = 'decorator'
       ORDER BY id`,
    )
    .all() as NodeRow[];
  for (const decorator of decorators) {
    for (const implementation of outgoingEdges(database, decorator.id, "IMPLEMENTED_BY")) {
      write(
        derivedEdge(repositoryId, {
          edgeType: "DECORATES",
          sourceNodeId: implementation.target_node_id,
          targetNodeId: decorator.id,
          evidence: implementation,
          relationship: "decorator_reverse_binding",
          confidence: implementation.confidence,
        }),
      );
    }
  }

  const registrations = database
    .prepare(
      `SELECT id, file_path, start_line, metadata_json
       FROM nodes
       WHERE kind = 'configuration'
         AND json_extract(metadata_json, '$.framework') = 'fastify'
         AND json_extract(metadata_json, '$.fastify_entity') = 'registration'
       ORDER BY id`,
    )
    .all() as NodeRow[];
  for (const registration of registrations) {
    const registrationMetadata = metadata(registration.metadata_json);
    const mounts = outgoingEdges(database, registration.id, "MOUNTS");
    const hooks = outgoingEdges(database, registration.id, "APPLIES_HOOK");
    for (const mount of mounts) {
      const routes = mountedRoutes(database, mount.target_node_id);
      for (const mountedRoute of routes) {
        const routeId = mountedRoute.routeId;
        if (typeof registrationMetadata.prefix_hash === "string") {
          const routeNode = database
            .prepare(
              `SELECT id, file_path, start_line, metadata_json FROM nodes WHERE id = ?`,
            )
            .get(routeId) as NodeRow | undefined;
          const routeMetadata = metadata(routeNode?.metadata_json ?? null);
          const registrationPath = [registration.id, ...mountedRoute.registrationPath];
          const prefixes = registrationPath.map((registrationId) => {
            const prefixNode = database
              .prepare(
                `SELECT id, file_path, start_line, metadata_json FROM nodes WHERE id = ?`,
              )
              .get(registrationId) as NodeRow | undefined;
            const value = metadata(prefixNode?.metadata_json ?? null).prefix_hash;
            return prefixNode !== undefined && typeof value === "string"
              ? literalForHash(repositoryRoot, prefixNode, "fastify_route_prefix", value)
              : null;
          });
          const routePath = routeNode === undefined ||
              typeof routeMetadata.route_path_hash !== "string"
            ? null
            : literalForHash(
                repositoryRoot,
                routeNode,
                "route",
                routeMetadata.route_path_hash,
              );
          const effectivePath = routePath === null || prefixes.some((prefix) => prefix === null)
            ? null
            : [...prefixes as string[], routePath].reduce(
                (current, segment) => effectiveRoutePath(current, segment),
                "/",
              );
          const effectivePathHash = effectivePath === null
            ? null
            : sha256(`route:${effectivePath}`);
          write(
            derivedEdge(repositoryId, {
              edgeType: "ROUTE_PREFIX",
              sourceNodeId: registration.id,
              targetNodeId: routeId,
              evidence: mount,
              relationship: "registered_route_prefix",
              metadata: {
                prefix_hash: registrationMetadata.prefix_hash,
                effective_route_path_hash: effectivePathHash,
                inherited_prefix_count: mountedRoute.registrationPath.length,
              },
            }),
          );
        }
        for (const hook of hooks) {
          write(
            derivedEdge(repositoryId, {
              edgeType: "PROTECTED_BY",
              sourceNodeId: routeId,
              targetNodeId: hook.target_node_id,
              evidence: hook,
              relationship: "registered_plugin_hook",
              confidence: Math.min(mount.confidence, hook.confidence),
            }),
          );
          for (const implementationId of hookImplementations(database, hook.target_node_id)) {
            write(
              derivedEdge(repositoryId, {
                edgeType: "MAY_CONTINUE_TO",
                sourceNodeId: implementationId,
                targetNodeId: routeId,
                evidence: hook,
                relationship: "fastify_hook_continuation",
                confidence: Math.min(mount.confidence, hook.confidence),
                metadata: {
                  conditional: true,
                  condition: "hook_completes_without_terminating_the_request",
                },
              }),
            );
          }
        }
      }
    }
  }

  const directProtection = database
    .prepare(
      `SELECT edges.source_node_id, edges.target_node_id, edges.edge_type,
              edges.source_type, edges.provenance_category, edges.confidence,
              edges.file_path, edges.line, edges.metadata_json
       FROM edges
       JOIN nodes route ON route.id = edges.source_node_id
       WHERE edges.edge_type = 'PROTECTED_BY' AND route.kind = 'api_route'
       ORDER BY edges.id`,
    )
    .all() as EdgeRow[];
  for (const protection of directProtection) {
    for (const implementationId of hookImplementations(database, protection.target_node_id)) {
      write(
        derivedEdge(repositoryId, {
          edgeType: "MAY_CONTINUE_TO",
          sourceNodeId: implementationId,
          targetNodeId: protection.source_node_id,
          evidence: protection,
          relationship: "fastify_hook_continuation",
          confidence: protection.confidence,
          metadata: {
            conditional: true,
            condition: "hook_completes_without_terminating_the_request",
          },
        }),
      );
    }
  }

  const hookBindings = database
    .prepare(
      `SELECT binding.id, binding.file_path, binding.start_line, binding.metadata_json,
              ownership.source_node_id AS owner_id
       FROM nodes binding
       JOIN edges ownership
         ON ownership.target_node_id = binding.id AND ownership.edge_type = 'CONFIGURES'
       WHERE json_extract(binding.metadata_json, '$.framework') = 'fastify'
         AND json_extract(binding.metadata_json, '$.fastify_entity') = 'hook_binding'
       ORDER BY binding.id`,
    )
    .all() as Array<NodeRow & { owner_id: string }>;
  for (const binding of hookBindings) {
    const routes = routesMountedBy(database, binding.owner_id);
    for (const hook of outgoingEdges(database, binding.id, "APPLIES_HOOK")) {
      for (const routeId of routes) {
        write(
          derivedEdge(repositoryId, {
            edgeType: "PROTECTED_BY",
            sourceNodeId: routeId,
            targetNodeId: hook.target_node_id,
            evidence: hook,
            relationship: "encapsulated_add_hook",
            confidence: hook.confidence,
          }),
        );
        for (const implementationId of hookImplementations(database, hook.target_node_id)) {
          write(
            derivedEdge(repositoryId, {
              edgeType: "MAY_CONTINUE_TO",
              sourceNodeId: implementationId,
              targetNodeId: routeId,
              evidence: hook,
              relationship: "fastify_hook_continuation",
              confidence: hook.confidence,
              metadata: {
                conditional: true,
                condition: "hook_completes_without_terminating_the_request",
              },
            }),
          );
        }
      }
    }
  }

  return written.size;
}
