import { performance } from "node:perf_hooks";
import { buildControlFlowForSymbol } from "../analysis/control-flow.js";
import { describeImpact } from "../analysis/impact.js";
import { rankSymbolSearch } from "../analysis/simplification.js";
import { loadConfig } from "../core/config.js";
import { CodeAtlasError } from "../core/errors.js";
import { compileChangeContextFromAtlas } from "../context/planner.js";
import { workspacePaths } from "../core/workspace.js";
import { compareSnapshots, loadSnapshot } from "../git/snapshots.js";
import { EvidenceExcerptReader } from "../ir/evidence.js";
import type { Atlas } from "../ir/models.js";
import { loadV2Config } from "../rules/config.js";
import {
  architectureService,
  type ArchitectureContext,
  type ArchitectureQueryContext,
} from "../service/architecture-service.js";
import {
  projectionSearchCandidates,
  type AtlasProjection,
} from "../service/atlas-projection.js";
import type { QueryProjectionRequest, QueryStore, QueryStoreMetrics } from "../storage/query-store.js";

export async function loadFreshIr(repositoryPath: string): Promise<Atlas> {
  return (await architectureService.load(repositoryPath)).atlas;
}

interface IrRuntime {
  repositoryRoot: string;
  atlas: Atlas;
  projection: AtlasProjection;
  queryStore: QueryStore;
  fingerprint: string;
  responseContext: CanonicalResponseContext;
  maxResultNodes: number;
  maxCallDepth: number;
  maxImpactDepth: number;
}

interface IrQueryRuntime {
  repositoryRoot: string;
  queryStore: QueryStore;
  fingerprint: string;
  responseContext: CanonicalResponseContext;
  maxResultNodes: number;
  schemaVersion: string;
}

interface CanonicalQueryTimings {
  freshness: number;
  retrieval: number;
  projection: number;
  serialization: number;
  transport: number;
}

interface CanonicalResponseContext {
  schemaVersion: string;
  snapshotIds: string[];
  fingerprint: string;
  generations: ArchitectureContext["status"]["generations"];
  freshness: {
    state: "current" | "stale";
    mode: ArchitectureContext["status"]["freshnessMode"];
    checked_at: string;
    cache_hit: boolean;
    rebuilt: boolean;
  };
  timingsMs: CanonicalQueryTimings;
  storage: {
    queries: number;
    rows_read: number;
    bytes_read: number;
  };
}

const RESPONSE_CONTEXT = Symbol("codeatlas.canonical-response-context");
const activeControlFlowLoads = new Map<string, Promise<Atlas["control_flows"][number] | null>>();

type ContextualResult = Record<string, unknown> & {
  [RESPONSE_CONTEXT]?: CanonicalResponseContext;
};

interface CursorPayload {
  version: 1;
  scope: string;
  fingerprint: string;
  offset: number;
}

interface PageRequest {
  limit: number;
  cursor?: string;
}

async function loadIrRuntime(repositoryPath: string): Promise<IrRuntime> {
  const context = await architectureService.load(repositoryPath);
  const configStartedAt = performance.now();
  const [config, v2Config] = await Promise.all([
    loadConfig(context.repositoryRoot),
    loadV2Config(context.repositoryRoot),
  ]);
  const responseContext = responseContextFrom(context);
  responseContext.timingsMs.retrieval += elapsed(configStartedAt);
  return {
    repositoryRoot: context.repositoryRoot,
    atlas: context.atlas,
    projection: context.projection,
    queryStore: context.queryStore,
    fingerprint: context.fingerprint,
    responseContext,
    maxResultNodes: config.limits.maxMcpResultNodes,
    maxCallDepth: Math.min(config.limits.maxTraversalDepth, v2Config.analysis.max_call_depth),
    maxImpactDepth: Math.min(config.limits.maxTraversalDepth, v2Config.analysis.max_impact_depth),
  };
}

async function loadQueryRuntime(repositoryPath: string): Promise<IrQueryRuntime> {
  const context = await architectureService.loadQuery(repositoryPath);
  const configStartedAt = performance.now();
  const config = await loadConfig(context.repositoryRoot);
  const responseContext = responseContextFrom(context);
  responseContext.timingsMs.retrieval += elapsed(configStartedAt);
  return {
    repositoryRoot: context.repositoryRoot,
    queryStore: context.queryStore,
    fingerprint: context.fingerprint,
    responseContext,
    maxResultNodes: config.limits.maxMcpResultNodes,
    schemaVersion: context.manifest.schema_version,
  };
}

function elapsed(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(3));
}

function responseContextFrom(context: ArchitectureContext | ArchitectureQueryContext): CanonicalResponseContext {
  const metadata = "atlas" in context ? context.atlas : context.manifest;
  return {
    schemaVersion: metadata.schema_version,
    snapshotIds: [metadata.snapshot.id],
    fingerprint: context.fingerprint,
    generations: context.status.generations,
    freshness: {
      state: context.status.architectureSynchronized ? "current" : "stale",
      mode: context.status.freshnessMode,
      checked_at: context.status.authoritativeCheckedAt,
      cache_hit: context.cacheHit,
      rebuilt: context.rebuilt,
    },
    timingsMs: {
      freshness: context.timingsMs.freshness,
      retrieval: context.timingsMs.retrieval,
      projection: context.timingsMs.projection,
      serialization: 0,
      transport: 0,
    },
    storage: { queries: 0, rows_read: 0, bytes_read: 0 },
  };
}

function recordStorageMetrics(
  context: CanonicalResponseContext,
  before: QueryStoreMetrics,
  after: QueryStoreMetrics,
): void {
  context.storage.queries += after.queries - before.queries;
  context.storage.rows_read += after.rowsRead - before.rowsRead;
  context.storage.bytes_read += after.bytesRead - before.bytesRead;
}

function measureProjection<T>(runtime: IrRuntime, operation: () => T): T {
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    runtime.responseContext.timingsMs.projection += elapsed(startedAt);
  }
}

function queryProjection(runtime: IrRuntime, request: QueryProjectionRequest) {
  const startedAt = performance.now();
  const metricsBefore = runtime.queryStore.metrics();
  try {
    return runtime.queryStore.queryProjection(request);
  } finally {
    runtime.responseContext.timingsMs.retrieval += elapsed(startedAt);
    recordStorageMetrics(runtime.responseContext, metricsBefore, runtime.queryStore.metrics());
  }
}

function withContext<T extends Record<string, unknown>>(
  value: T,
  context: CanonicalResponseContext,
): T {
  Object.defineProperty(value, RESPONSE_CONTEXT, {
    configurable: false,
    enumerable: false,
    value: context,
    writable: false,
  });
  return value;
}

function withRuntime<T extends Record<string, unknown>>(
  value: T,
  runtime: Pick<IrRuntime, "responseContext"> | Pick<IrQueryRuntime, "responseContext">,
): T {
  return withContext(value, runtime.responseContext);
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, scope: string, fingerprint: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      value.version !== 1 ||
      value.scope !== scope ||
      value.fingerprint !== fingerprint ||
      !Number.isInteger(value.offset) ||
      (value.offset ?? -1) < 0
    ) {
      throw new Error("cursor context mismatch");
    }
    return value.offset!;
  } catch (error) {
    throw new CodeAtlasError("Invalid or stale canonical-IR cursor. Restart the query without a cursor.", {
      cause: error,
      code: "stale_cursor",
      recoverable: true,
      nextActions: ["Retry the same query without a cursor."],
    });
  }
}

function page<T>(
  items: readonly T[],
  request: PageRequest,
  scope: string,
  runtime: Pick<IrRuntime, "fingerprint" | "maxResultNodes"> | Pick<IrQueryRuntime, "fingerprint" | "maxResultNodes">,
): { items: T[]; pagination: { limit: number; returned: number; total: number; cursor: string | null; has_more: boolean } } {
  if (request.limit > runtime.maxResultNodes) {
    throw new CodeAtlasError(
      `Requested limit exceeds config.limits.maxMcpResultNodes (${runtime.maxResultNodes}).`,
      {
        code: "limit_exceeded",
        recoverable: true,
        nextActions: [`Retry with limit at or below ${runtime.maxResultNodes}.`],
        details: { maximum: runtime.maxResultNodes },
      },
    );
  }
  const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor, scope, runtime.fingerprint);
  const selected: T[] = [];
  let selectedBytes = 0;
  const maximumPageBytes = 1_000_000;
  for (const item of items.slice(offset, offset + request.limit)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item) ?? "null", "utf8");
    if (selectedBytes + itemBytes > maximumPageBytes) {
      if (selected.length === 0) {
        throw new CodeAtlasError(
          `One result exceeds the canonical-IR page byte limit (${maximumPageBytes}).`,
          {
            code: "result_too_large",
            recoverable: true,
            nextActions: ["Narrow the query or request a smaller projection."],
            details: { maximum_bytes: maximumPageBytes },
          },
        );
      }
      break;
    }
    selected.push(item);
    selectedBytes += itemBytes;
  }
  const nextOffset = offset + selected.length;
  const hasMore = nextOffset < items.length;
  return {
    items: selected,
    pagination: {
      limit: request.limit,
      returned: selected.length,
      total: items.length,
      cursor: hasMore
        ? encodeCursor({ version: 1, scope, fingerprint: runtime.fingerprint, offset: nextOffset })
        : null,
      has_more: hasMore,
    },
  };
}

function validateDepth(depth: number, maximum: number, label: string): void {
  if (depth > maximum) {
    throw new CodeAtlasError(`Requested ${label} exceeds configured maximum (${maximum}).`, {
      code: "depth_exceeded",
      recoverable: true,
      nextActions: [`Retry with ${label} at or below ${maximum}.`],
      details: { maximum },
    });
  }
}

function resolve(projection: AtlasProjection, target: string) {
  const exactId = projection.symbolById.get(target);
  if (exactId !== undefined) return exactId;
  const needle = target.toLocaleLowerCase();
  const exactQualified = projection.symbolsByQualifiedName.get(needle) ?? [];
  if (exactQualified.length === 1) return exactQualified[0]!;
  if (exactQualified.length > 1) {
    const candidates = exactQualified.slice(0, 10).map((symbol) =>
      `${symbol.id} (${symbol.kind} ${symbol.file ?? "unknown file"})`
    ).join(", ");
    throw new CodeAtlasError(
      `Ambiguous symbol: ${target}. Use an exact ID. Candidates: ${candidates}`,
      {
        code: "ambiguous_symbol",
        recoverable: true,
        nextActions: ["Choose one candidate ID and retry."],
        details: { candidate_ids: exactQualified.map((symbol) => symbol.id) },
      },
    );
  }
  const matches = projectionSearchCandidates(projection, target);
  if (matches.length !== 1) throw new CodeAtlasError(matches.length === 0
    ? `Symbol not found: ${target}`
    : `Ambiguous symbol: ${target}. Use an exact ID from find_symbol.`, matches.length === 0
      ? {
          code: "symbol_not_found",
          recoverable: true,
          nextActions: ["Use find_symbol to discover a stable symbol ID."],
        }
      : {
          code: "ambiguous_symbol",
          recoverable: true,
          nextActions: ["Use find_symbol, choose one candidate ID, and retry."],
          details: { candidate_ids: matches.slice(0, 50).map((symbol) => symbol.id) },
        });
  return matches[0]!;
}

function resolutionIssuesFor(
  projection: AtlasProjection,
  symbolIds: ReadonlySet<string>,
  limit: number,
) {
  const matches = new Map<string, Atlas["resolution_issues"][number]>();
  for (const symbolId of symbolIds) {
    for (const issue of projection.resolutionIssuesBySymbolId.get(symbolId) ?? []) {
      matches.set(issue.id, issue);
    }
  }
  const items = [...matches.values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
  };
}

async function hydrateEvidence(runtime: IrRuntime, evidence: readonly Atlas["evidence"][number][]) {
  const reader = new EvidenceExcerptReader(runtime.repositoryRoot);
  return Promise.all(evidence.map(async (item) => {
    const excerpt = await reader.read(item.file, item.start_line, item.end_line);
    return { ...item, excerpt: excerpt.excerpt, excerpt_status: excerpt.status };
  }));
}

export async function findSymbolIr(repositoryPath: string, query: string, limit: number, cursor?: string) {
  const runtime = await loadQueryRuntime(repositoryPath);
  const needle = query.toLocaleLowerCase();
  const metricsBefore = runtime.queryStore.metrics();
  const retrievalStartedAt = performance.now();
  const indexed = runtime.queryStore.searchSymbols(query, 10_000);
  const hydrated = runtime.queryStore.getSymbols(indexed.items.map((item) => item.id), 10_000);
  runtime.responseContext.timingsMs.retrieval += elapsed(retrievalStartedAt);
  const indexedPosition = new Map(indexed.items.map((item, position) => [item.id, position]));
  const projectionStartedAt = performance.now();
  const matches = hydrated.items
    .map((symbol) => ({
      symbol,
      score: rankSymbolSearch(symbol, query) || Math.max(1, 10_000 - (indexedPosition.get(symbol.id) ?? 10_000)),
    }))
    .sort((left, right) => right.score - left.score || left.symbol.id.localeCompare(right.symbol.id))
    .map((item) => item.symbol);
  runtime.responseContext.timingsMs.projection += elapsed(projectionStartedAt);
  const metricsAfter = runtime.queryStore.metrics();
  recordStorageMetrics(runtime.responseContext, metricsBefore, metricsAfter);
  const result = page(matches, { limit, ...(cursor === undefined ? {} : { cursor }) }, `find_symbol:${needle}`, runtime);
  return withRuntime({
    schema_version: runtime.schemaVersion,
    derivation: "canonical_ir",
    results: result.items,
    retrieval: {
      strategy: "sqlite_fts_enriched+bounded_hydration",
      indexed_candidates: indexed.items.length,
      ranked_candidates: matches.length,
      query_count: metricsAfter.queries - metricsBefore.queries,
      rows_read: metricsAfter.rowsRead - metricsBefore.rowsRead,
      bytes_read: metricsAfter.bytesRead - metricsBefore.bytesRead,
      truncated: indexed.truncated || hydrated.truncated,
    },
    pagination: result.pagination,
  }, runtime);
}

export async function callersIr(repositoryPath: string, target: string, limit: number, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const symbol = resolve(runtime.projection, target);
  const projection = queryProjection(runtime, {
    relationships: {
      symbolIds: [symbol.id],
      direction: "incoming",
      types: ["CALLS", "HANDLES", "TRIGGERS", "MAY_CONTINUE_TO"],
    },
    limit: 10_000,
  });
  const matches = projection.relationships.items.flatMap((item) =>
    runtime.projection.relationshipById.get(item.id) ?? []
  );
  const result = page(matches, { limit, ...(cursor === undefined ? {} : { cursor }) }, `callers:${symbol.id}`, runtime);
  const relationships = result.items;
  const ids = new Set(relationships.map((edge) => edge.source));
  const relatedIds = new Set([symbol.id, ...ids]);
  return withRuntime({
    symbol,
    direct_callers: relationships.length,
    callers: [...ids].flatMap((id) => runtime.projection.symbolById.get(id) ?? []),
    relationships,
    resolution_issues: resolutionIssuesFor(runtime.projection, relatedIds, runtime.maxResultNodes),
    pagination: result.pagination,
  }, runtime);
}

export async function symbolIr(repositoryPath: string, target: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const symbol = resolve(runtime.projection, target);
  const projection = queryProjection(runtime, {
    symbolIds: [symbol.id],
    relationships: { symbolIds: [symbol.id], direction: "both" },
    evidence: { symbolIds: [symbol.id] },
    limit: runtime.maxResultNodes + 1,
  });
  if (!projection.symbols.items.some((item) => item.id === symbol.id)) {
    throw new CodeAtlasError(`Symbol is not present in the current query generation: ${target}`, {
      code: "stale_projection",
      recoverable: true,
      nextActions: ["Retry the query so CodeAtlas can reconcile the current generation."],
    });
  }
  const relationships = projection.relationships.items.flatMap((item) =>
    runtime.projection.relationshipById.get(item.id) ?? []
  );
  const result = page(relationships, { limit: runtime.maxResultNodes }, `symbol:${symbol.id}:relationships`, runtime);
  return withRuntime({
    symbol,
    relationships: result.items,
    pagination: result.pagination,
    evidence: projection.evidence.items.flatMap((item) =>
      runtime.projection.evidenceById.get(item.id) ?? []
    ),
    resolution_issues: resolutionIssuesFor(runtime.projection, new Set([symbol.id]), runtime.maxResultNodes),
  }, runtime);
}

export async function repositoryOverviewIr(repositoryPath: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const domains = page(atlas.domains, { limit: runtime.maxResultNodes }, "overview:domains", runtime);
  const entrypointIds = new Set(atlas.entrypoint_ids);
  const entrypointSymbols = atlas.symbols.filter((symbol) => entrypointIds.has(symbol.id));
  const entrypoints = page(entrypointSymbols, { limit: runtime.maxResultNodes }, "overview:entrypoints", runtime);
  const issuesByReason = Object.fromEntries(
    [...new Set(atlas.resolution_issues.map((issue) => issue.reason))]
      .sort((left, right) => left.localeCompare(right))
      .map((reason) => [reason, atlas.resolution_issues.filter((issue) => issue.reason === reason).length]),
  );
  return withRuntime({
    schema_version: atlas.schema_version,
    project: atlas.project,
    snapshot: atlas.snapshot,
    statistics: atlas.statistics,
    domains: domains.items.map((domain) => ({
      id: domain.id, name: domain.name, members: domain.member_ids.length, entrypoints: domain.entrypoint_ids.length,
    })),
    entrypoints: entrypoints.items,
    resolution_issues: { total: atlas.resolution_issues.length, by_reason: issuesByReason },
    pagination: { domains: domains.pagination, entrypoints: entrypoints.pagination },
  }, runtime);
}

export async function changeContextIr(repositoryPath: string, task: string, budget: number) {
  const runtime = await loadIrRuntime(repositoryPath);
  const packet = measureProjection(runtime, () => compileChangeContextFromAtlas(
    runtime.atlas,
    runtime.repositoryRoot,
    {
      id: runtime.atlas.snapshot.id,
      fingerprint: runtime.fingerprint,
      generations: runtime.responseContext.generations,
    },
    task,
    {
      budget,
      format: "json",
      envelopeReserve: 1_400,
    },
    { projection: runtime.projection, queryStore: runtime.queryStore },
  ));
  return withRuntime(packet as unknown as Record<string, unknown>, runtime);
}

export async function neighborhoodIr(
  repositoryPath: string,
  target: string,
  direction: "outgoing" | "incoming",
  limit: number,
  cursor?: string,
) {
  const runtime = await loadIrRuntime(repositoryPath);
  const symbol = resolve(runtime.projection, target);
  const projection = queryProjection(runtime, {
    relationships: { symbolIds: [symbol.id], direction },
    limit: 10_000,
  });
  const matches = projection.relationships.items.flatMap((item) =>
    runtime.projection.relationshipById.get(item.id) ?? []
  );
  const result = page(
    matches,
    { limit, ...(cursor === undefined ? {} : { cursor }) },
    `neighborhood:${direction}:${symbol.id}`,
    runtime,
  );
  const relationships = result.items;
  const ids = new Set(relationships.map((edge) => direction === "outgoing" ? edge.target : edge.source));
  return withRuntime({
    symbol,
    direction,
    relationships,
    symbols: [...ids].flatMap((id) => runtime.projection.symbolById.get(id) ?? []),
    resolution_issues: resolutionIssuesFor(runtime.projection, new Set([symbol.id, ...ids]), runtime.maxResultNodes),
    pagination: result.pagination,
  }, runtime);
}

export async function tracePathIr(repositoryPath: string, from: string, to: string, depth: number) {
  const runtime = await loadIrRuntime(repositoryPath);
  validateDepth(depth, runtime.maxCallDepth, "depth");
  const source = resolve(runtime.projection, from);
  const target = resolve(runtime.projection, to);
  const outgoing = runtime.projection.outgoingBySymbolId;
  const queue = [{ id: source.id, symbols: [source.id], relationships: [] as string[] }];
  const visited = new Set([source.id]);
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.id === target.id) {
      return withRuntime({
        source,
        target,
        path: current,
        depth_limit: depth,
        truncated,
        resolution_issues: resolutionIssuesFor(runtime.projection, new Set(current.symbols), runtime.maxResultNodes),
      }, runtime);
    }
    if (current.relationships.length >= depth) {
      if ((outgoing.get(current.id) ?? []).some((edge) => !visited.has(edge.target))) truncated = true;
      continue;
    }
    for (const edge of outgoing.get(current.id) ?? []) {
      if (["CONTAINS", "BELONGS_TO_DOMAIN", "BELONGS_TO_FEATURE"].includes(edge.type)) continue;
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      queue.push({
        id: edge.target,
        symbols: [...current.symbols, edge.target],
        relationships: [...current.relationships, edge.id],
      });
    }
  }
  return withRuntime({
    source,
    target,
    path: null,
    depth_limit: depth,
    truncated,
    resolution_issues: resolutionIssuesFor(runtime.projection, new Set([source.id, target.id]), runtime.maxResultNodes),
  }, runtime);
}

export async function impactIr(repositoryPath: string, target: string, depth: number, limit: number) {
  const runtime = await loadIrRuntime(repositoryPath);
  validateDepth(depth, runtime.maxImpactDepth, "impact depth");
  if (limit > runtime.maxResultNodes) {
    throw new CodeAtlasError(`Requested limit exceeds config.limits.maxMcpResultNodes (${runtime.maxResultNodes}).`, {
      code: "limit_exceeded",
      recoverable: true,
      nextActions: [`Retry with limit at or below ${runtime.maxResultNodes}.`],
      details: { maximum: runtime.maxResultNodes },
    });
  }
  const atlas = runtime.atlas;
  const symbol = resolve(runtime.projection, target);
  const analysis = describeImpact(atlas, symbol.id, { depth, limit });
  const truncated = [
    analysis.paths,
    analysis.dependency_paths,
    analysis.potential_paths ?? [],
    analysis.potential_dependency_paths ?? [],
  ].some((paths) => paths.length >= limit);
  return withRuntime({
    symbol,
    ...analysis,
    query: { depth_limit: depth, result_limit: limit, truncated },
    resolution_issues: resolutionIssuesFor(runtime.projection, new Set([
      symbol.id,
      ...analysis.paths.flatMap((path) => path.path),
      ...analysis.dependency_paths.flatMap((path) => path.path),
      ...(analysis.potential_paths ?? []).flatMap((path) => path.path),
      ...(analysis.potential_dependency_paths ?? []).flatMap((path) => path.path),
    ]), runtime.maxResultNodes),
  }, runtime);
}

export async function flowIr(repositoryPath: string, target: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const symbol = resolve(runtime.projection, target);
  const flow = atlas.flows.find((candidate) => candidate.entrypoint_id === symbol.id || candidate.id === target) ?? null;
  return withRuntime(
    {
      flow,
      resolution_issues: resolutionIssuesFor(
        runtime.projection,
        new Set([symbol.id, ...(flow?.steps.map((step) => step.symbol_id) ?? [])]),
        runtime.maxResultNodes,
      ),
    },
    runtime,
  );
}

export async function controlFlowIr(repositoryPath: string, target: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const symbol = resolve(runtime.projection, target);
  let controlFlow = runtime.projection.controlFlowBySymbolId.get(symbol.id) ?? null;
  let generation: "precomputed" | "on_demand" | "unavailable" = controlFlow === null
    ? "unavailable"
    : "precomputed";
  if (controlFlow === null && ["function", "method"].includes(symbol.kind)) {
    const key = `${runtime.repositoryRoot}\0${runtime.fingerprint}\0${symbol.id}`;
    let active = activeControlFlowLoads.get(key);
    if (active === undefined) {
      active = buildControlFlowForSymbol(runtime.atlas, runtime.repositoryRoot, symbol);
      activeControlFlowLoads.set(key, active);
    }
    const startedAt = performance.now();
    try {
      controlFlow = await active;
    } finally {
      runtime.responseContext.timingsMs.projection += elapsed(startedAt);
      if (activeControlFlowLoads.get(key) === active) activeControlFlowLoads.delete(key);
    }
    if (controlFlow !== null) {
      runtime.projection.registerControlFlow(controlFlow);
      runtime.queryStore.cacheControlFlow(controlFlow);
      generation = "on_demand";
    }
  }
  return withRuntime(
    {
      symbol,
      control_flow: controlFlow,
      generation,
      resolution_issues: resolutionIssuesFor(runtime.projection, new Set([symbol.id]), runtime.maxResultNodes),
    },
    runtime,
  );
}

export async function evidenceIr(repositoryPath: string, target: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const issue = atlas.resolution_issues.find((candidate) => candidate.id === target);
  if (issue !== undefined) {
    const projection = queryProjection(runtime, {
      evidence: { resolutionIssueIds: [issue.id] },
      limit: runtime.maxResultNodes,
    });
    const evidence = projection.evidence.items.flatMap((item) =>
      runtime.projection.evidenceById.get(item.id) ?? []
    );
    return withRuntime({
      resolution_issue: issue,
      evidence: await hydrateEvidence(runtime, evidence),
    }, runtime);
  }
  const direct = runtime.projection.evidenceById.get(target);
  if (direct !== undefined) {
    if (
      direct.symbol_id === null && direct.relationship_id === null &&
      direct.resolution_issue_id === null
    ) return withRuntime({ evidence: await hydrateEvidence(runtime, [direct]) }, runtime);
    const projection = queryProjection(runtime, {
      evidence: {
        ...(direct.symbol_id === null ? {} : { symbolIds: [direct.symbol_id] }),
        ...(direct.relationship_id === null ? {} : { relationshipIds: [direct.relationship_id] }),
        ...(direct.resolution_issue_id === null ? {} : { resolutionIssueIds: [direct.resolution_issue_id] }),
      },
      limit: runtime.maxResultNodes,
    });
    const projected = projection.evidence.items.some((item) => item.id === direct.id);
    return withRuntime({
      evidence: await hydrateEvidence(runtime, [direct]),
      retrieval: { source: projected ? "sqlite_projection" : "generation_projection" },
    }, runtime);
  }
  const symbol = resolve(runtime.projection, target);
  const projection = queryProjection(runtime, {
    evidence: { symbolIds: [symbol.id] },
    limit: runtime.maxResultNodes,
  });
  const evidence = projection.evidence.items.flatMap((item) =>
    runtime.projection.evidenceById.get(item.id) ?? []
  );
  return withRuntime(
    {
      symbol,
      evidence: await hydrateEvidence(runtime, evidence),
      resolution_issues: resolutionIssuesFor(runtime.projection, new Set([symbol.id]), runtime.maxResultNodes),
    },
    runtime,
  );
}

export async function domainsIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const result = page(runtime.atlas.domains, { limit, ...(cursor === undefined ? {} : { cursor }) }, "domains", runtime);
  return withRuntime({ domains: result.items, pagination: result.pagination }, runtime);
}

export async function domainIr(repositoryPath: string, target: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const needle = target.toLocaleLowerCase();
  const domain = atlas.domains.find((item) => item.id === target || item.name.toLocaleLowerCase() === needle);
  if (domain === undefined) throw new CodeAtlasError(`Domain not found: ${target}`, {
    code: "domain_not_found",
    recoverable: true,
    nextActions: ["Use list_domains to choose a valid domain ID."],
  });
  const members = new Set(domain.member_ids);
  const result = page(
    atlas.symbols.filter((symbol) => members.has(symbol.id)),
    { limit, ...(cursor === undefined ? {} : { cursor }) },
    `domain:${domain.id}`,
    runtime,
  );
  return withRuntime({ domain, symbols: result.items, pagination: result.pagination }, runtime);
}

export async function entrypointsIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const ids = new Set(atlas.entrypoint_ids);
  const entries = atlas.symbols.filter((symbol) => ids.has(symbol.id));
  const result = page(entries, { limit, ...(cursor === undefined ? {} : { cursor }) }, "entrypoints", runtime);
  const visibleIds = new Set(result.items.map((symbol) => symbol.id));
  return withRuntime({
    entrypoints: result.items,
    flows: atlas.flows.filter((flow) => visibleIds.has(flow.entrypoint_id)),
    pagination: result.pagination,
  }, runtime);
}

export async function changesIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const result = page(runtime.atlas.git_changes, { limit, ...(cursor === undefined ? {} : { cursor }) }, "git_changes", runtime);
  return withRuntime({ changes: result.items, pagination: result.pagination }, runtime);
}

export async function rulesIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const rules = page(runtime.atlas.rules, { limit, ...(cursor === undefined ? {} : { cursor }) }, "rules", runtime);
  return withRuntime({ rules: rules.items, pagination: rules.pagination }, runtime);
}

export async function ruleViolationsIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const violations = page(
    runtime.atlas.rule_violations,
    { limit, ...(cursor === undefined ? {} : { cursor }) },
    "rule_violations",
    runtime,
  );
  return withRuntime({ violations: violations.items, pagination: violations.pagination }, runtime);
}

export async function reviewIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const findings = page(runtime.atlas.review_findings, { limit, ...(cursor === undefined ? {} : { cursor }) }, "review_findings", runtime);
  return withRuntime({ findings: findings.items, pagination: findings.pagination }, runtime);
}

export const SNAPSHOT_SECTIONS = [
  "summary",
  "symbols",
  "relationships",
  "evidence",
  "resolution_issues",
  "domains",
  "flows",
  "control_flows",
  "git_changes",
  "rules",
  "rule_violations",
  "review_findings",
] as const;

export type SnapshotSection = (typeof SNAPSHOT_SECTIONS)[number];

function snapshotSectionItems(atlas: Atlas, section: Exclude<SnapshotSection, "summary">): readonly unknown[] {
  return atlas[section];
}

export async function snapshotIr(
  repositoryPath: string,
  id: string,
  section: SnapshotSection = "summary",
  limit = 100,
  cursor?: string,
) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = await loadSnapshot(workspacePaths(runtime.repositoryRoot).snapshots, id);
  const snapshot = {
    schema_version: atlas.schema_version,
    generator: atlas.generator,
    project: atlas.project,
    snapshot: atlas.snapshot,
    statistics: atlas.statistics,
    sections: Object.fromEntries(
      SNAPSHOT_SECTIONS.filter((name) => name !== "summary").map((name) => [name, atlas[name].length]),
    ),
  };
  if (section === "summary") {
    return withContext({
      snapshot,
      section,
      items: [],
      pagination: { limit: 0, returned: 0, total: 0, cursor: null, has_more: false },
    }, {
      ...runtime.responseContext,
      schemaVersion: atlas.schema_version,
      snapshotIds: [atlas.snapshot.id],
    });
  }
  const snapshotRuntime = {
    ...runtime,
    fingerprint: [
      "snapshot",
      atlas.snapshot.id,
      atlas.snapshot.created_at,
      atlas.generator.version,
      atlas.generator.indexer_version,
    ].join(":"),
  };
  const result = page(
    snapshotSectionItems(atlas, section),
    { limit, ...(cursor === undefined ? {} : { cursor }) },
    `snapshot:${atlas.snapshot.id}:${section}`,
    snapshotRuntime,
  );
  return withContext(
    { snapshot, section, items: result.items, pagination: result.pagination },
    {
      ...runtime.responseContext,
      schemaVersion: atlas.schema_version,
      snapshotIds: [atlas.snapshot.id],
    },
  );
}

export async function compareSnapshotsIr(repositoryPath: string, oldId: string, newId: string) {
  const context = await architectureService.load(repositoryPath);
  return withContext(
    { diff: await compareSnapshots(workspacePaths(context.repositoryRoot).snapshots, oldId, newId) },
    {
      ...responseContextFrom(context),
      snapshotIds: [oldId, newId],
    },
  );
}

interface CoverageEnvelope {
  bounded: boolean;
  truncated: boolean;
  limitations: string[];
}

interface UncertaintyEnvelope {
  inferred_facts: number;
  unresolved_references: number;
  ambiguous_references: number;
  dynamic_references: number;
  conditional_relationships: number;
}

function coverageEnvelope(value: Record<string, unknown>): CoverageEnvelope {
  let bounded = false;
  let truncated = false;
  let structuredControlFlow = false;
  const unsupportedConstructs = new Set<string>();
  const seen = new Set<object>();

  const visit = (candidate: unknown, key?: string): void => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (
      key === "pagination" || "has_more" in record || "truncated" in record ||
      "depth_limit" in record || "result_limit" in record
    ) bounded = true;
    if (record.has_more === true || record.truncated === true) truncated = true;
    if (record.analysis_kind === "structured_ast_approximation") structuredControlFlow = true;
    if (Array.isArray(record.unsupported_constructs)) {
      for (const construct of record.unsupported_constructs) {
        if (typeof construct === "string") unsupportedConstructs.add(construct);
      }
    }
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(value);

  const limitations: string[] = [];
  if (truncated) limitations.push("The response is partial; follow pagination cursors or narrow the query.");
  if (structuredControlFlow) {
    limitations.push("Control flow is a structured AST approximation, not compiler-level path analysis.");
  }
  if (unsupportedConstructs.size > 0) {
    limitations.push(`Unsupported control-flow constructs: ${[...unsupportedConstructs].sort().join(", ")}.`);
  }
  return { bounded, truncated, limitations };
}

function uncertaintyEnvelope(value: Record<string, unknown>): UncertaintyEnvelope {
  const inferred = new Set<string>();
  const unresolved = new Set<string>();
  const ambiguous = new Set<string>();
  const dynamic = new Set<string>();
  const conditional = new Set<string>();
  const seen = new Set<object>();
  let anonymous = 0;

  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = candidate as Record<string, unknown>;
    const identity = typeof record.id === "string" ? record.id : `anonymous:${anonymous++}`;
    if (record.fact_class === "INFERRED" || record.provenance_category === "inferred") inferred.add(identity);
    if (record.reason === "unresolved_reference") unresolved.add(identity);
    if (record.reason === "multi_candidate" || record.target_resolution === "ambiguous") ambiguous.add(identity);
    if (
      record.reason === "dynamic_relationship" || record.target_resolution === "dynamic" ||
      record.provenance_category === "dynamic"
    ) dynamic.add(identity);
    if (record.execution_semantics === "conditional") conditional.add(identity);
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return {
    inferred_facts: inferred.size,
    unresolved_references: unresolved.size,
    ambiguous_references: ambiguous.size,
    dynamic_references: dynamic.size,
    conditional_relationships: conditional.size,
  };
}

function responseEnvelope(value: Record<string, unknown>, context?: CanonicalResponseContext) {
  return {
    schema_version: context?.schemaVersion ?? null,
    snapshot_ids: context?.snapshotIds ?? [],
    fingerprint: context?.fingerprint ?? null,
    generations: context?.generations ?? null,
    freshness: context?.freshness ?? null,
    content_trust: {
      indexing: "local_only" as const,
      repository_content: "untrusted" as const,
      answer_policy: "evidence_only" as const,
    },
    coverage: coverageEnvelope(value),
    uncertainty: uncertaintyEnvelope(value),
    performance: context === undefined ? null : {
      timings_ms: context.timingsMs,
      storage: context.storage,
      rss_mib: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
      transport_scope: "response_construction",
    },
  };
}

function serializeCanonicalResponse(
  enriched: Record<string, unknown>,
  context?: CanonicalResponseContext,
): { serialized: string; serializedBytes: number } {
  if (context === undefined) {
    const serialized = JSON.stringify(enriched);
    return { serialized, serializedBytes: Buffer.byteLength(serialized, "utf8") };
  }
  const serializationStartedAt = performance.now();
  const provisional = JSON.stringify(enriched);
  context.timingsMs.serialization += elapsed(serializationStartedAt);
  const transportStartedAt = performance.now();
  const provisionalContent = [{ type: "text" as const, text: provisional }];
  Buffer.byteLength(provisionalContent[0]!.text, "utf8");
  context.timingsMs.transport += elapsed(transportStartedAt);
  const serialized = JSON.stringify(enriched);
  return { serialized, serializedBytes: Buffer.byteLength(serialized, "utf8") };
}

export function irResult(value: ContextualResult) {
  const context = value[RESPONSE_CONTEXT];
  const enriched = {
    derivation: "canonical_ir",
    status: "ok" as const,
    error: null,
    ...value,
    codeatlas: responseEnvelope(value, context),
    next_actions: [
      "Use exact stable IDs from this response in follow-up MCP calls.",
      "Use get_evidence for source-backed details and analyze_impact for blast-radius paths.",
    ],
  };
  const { serialized, serializedBytes } = serializeCanonicalResponse(enriched, context);
  const maximumBytes = 2_000_000;
  if (serializedBytes > maximumBytes) {
    throw new CodeAtlasError(
      `Canonical-IR response is ${serializedBytes} bytes; reduce the requested limit to stay below ${maximumBytes} bytes.`,
      {
        code: "result_too_large",
        recoverable: true,
        nextActions: ["Reduce the requested limit and continue with pagination."],
        details: { actual_bytes: serializedBytes, maximum_bytes: maximumBytes },
      },
    );
  }
  return {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent: enriched,
  };
}

export async function irErrorResult(error: unknown, repositoryPath: string) {
  let context: CanonicalResponseContext | undefined;
  try {
    context = responseContextFrom(await architectureService.loadQuery(repositoryPath));
  } catch {
    context = undefined;
  }
  const filesystemCode = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
  const invalidSnapshot = error instanceof Error && error.message.startsWith("Invalid snapshot ID:");
  const known = error instanceof CodeAtlasError;
  const code = known ? error.code
    : filesystemCode === "ENOENT" ? "snapshot_not_found"
    : invalidSnapshot ? "invalid_argument" : "internal_error";
  const recoverable = known ? error.recoverable : filesystemCode === "ENOENT" || invalidSnapshot;
  const nextActions = known ? error.nextActions
    : filesystemCode === "ENOENT" ? ["Use get_snapshot with an existing snapshot ID."]
    : invalidSnapshot ? ["Use a snapshot ID returned by the snapshot command."] : [];
  const details = known ? error.details : {};
  const message = error instanceof Error ? error.message : "CodeAtlas could not complete the query.";
  const value = { error: { code, message, recoverable, details } };
  const enriched = {
    derivation: "canonical_ir" as const,
    status: "error" as const,
    ...value,
    codeatlas: responseEnvelope(value, context),
    next_actions: nextActions,
  };
  const { serialized } = serializeCanonicalResponse(enriched, context);
  return {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent: enriched,
    isError: true,
  };
}
