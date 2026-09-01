import { describeImpact } from "../analysis/impact.js";
import { rankSymbolSearch } from "../analysis/simplification.js";
import { loadConfig } from "../core/config.js";
import { CodeAtlasError } from "../core/errors.js";
import { workspacePaths } from "../core/workspace.js";
import { compareSnapshots, loadSnapshot } from "../git/snapshots.js";
import type { Atlas } from "../ir/models.js";
import { loadV2Config } from "../rules/config.js";
import { architectureService } from "../service/architecture-service.js";

export async function loadFreshIr(repositoryPath: string): Promise<Atlas> {
  return (await architectureService.load(repositoryPath)).atlas;
}

interface IrRuntime {
  repositoryRoot: string;
  atlas: Atlas;
  fingerprint: string;
  maxResultNodes: number;
  maxCallDepth: number;
  maxImpactDepth: number;
}

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
  const [config, v2Config] = await Promise.all([
    loadConfig(context.repositoryRoot),
    loadV2Config(context.repositoryRoot),
  ]);
  return {
    repositoryRoot: context.repositoryRoot,
    atlas: context.atlas,
    fingerprint: context.fingerprint,
    maxResultNodes: config.limits.maxMcpResultNodes,
    maxCallDepth: Math.min(config.limits.maxTraversalDepth, v2Config.analysis.max_call_depth),
    maxImpactDepth: Math.min(config.limits.maxTraversalDepth, v2Config.analysis.max_impact_depth),
  };
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
    throw new CodeAtlasError("Invalid or stale canonical-IR cursor. Restart the query without a cursor.", { cause: error });
  }
}

function page<T>(
  items: readonly T[],
  request: PageRequest,
  scope: string,
  runtime: IrRuntime,
): { items: T[]; pagination: { limit: number; returned: number; total: number; cursor: string | null; has_more: boolean } } {
  if (request.limit > runtime.maxResultNodes) {
    throw new CodeAtlasError(
      `Requested limit exceeds config.limits.maxMcpResultNodes (${runtime.maxResultNodes}).`,
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
    throw new CodeAtlasError(`Requested ${label} exceeds configured maximum (${maximum}).`);
  }
}

function resolve(atlas: Atlas, target: string) {
  const exact = atlas.symbols.find((symbol) => symbol.id === target || symbol.qualified_name === target);
  if (exact !== undefined) return exact;
  const needle = target.toLocaleLowerCase();
  const matches = atlas.symbols.filter((symbol) =>
    symbol.name.toLocaleLowerCase().includes(needle) ||
    symbol.qualified_name?.toLocaleLowerCase().includes(needle) ||
    symbol.file?.toLocaleLowerCase().includes(needle),
  );
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? `Symbol not found: ${target}`
    : `Ambiguous symbol: ${target}. Use an exact ID or qualified name.`);
  return matches[0]!;
}

export async function findSymbolIr(repositoryPath: string, query: string, limit: number, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const needle = query.toLocaleLowerCase();
  const matches = atlas.symbols
    .map((symbol) => ({ symbol, score: rankSymbolSearch(symbol, query, atlas) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.id.localeCompare(right.symbol.id))
    .map((item) => item.symbol);
  const result = page(matches, { limit, ...(cursor === undefined ? {} : { cursor }) }, `find_symbol:${needle}`, runtime);
  return {
    schema_version: atlas.schema_version,
    derivation: "canonical_ir",
    results: result.items,
    pagination: result.pagination,
  };
}

export async function callersIr(repositoryPath: string, target: string, limit: number, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const symbol = resolve(atlas, target);
  const matches = atlas.relationships.filter((edge) =>
    edge.target === symbol.id && ["CALLS", "HANDLES", "TRIGGERS", "MAY_CONTINUE_TO"].includes(edge.type),
  );
  const result = page(matches, { limit, ...(cursor === undefined ? {} : { cursor }) }, `callers:${symbol.id}`, runtime);
  const relationships = result.items;
  const ids = new Set(relationships.map((edge) => edge.source));
  return {
    symbol,
    direct_callers: relationships.length,
    callers: atlas.symbols.filter((item) => ids.has(item.id)),
    relationships,
    pagination: result.pagination,
  };
}

export async function symbolIr(repositoryPath: string, target: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const symbol = resolve(atlas, target);
  const evidenceIds = new Set(symbol.evidence_ids);
  const relationships = atlas.relationships.filter((edge) => edge.source === symbol.id || edge.target === symbol.id);
  const result = page(relationships, { limit: runtime.maxResultNodes }, `symbol:${symbol.id}:relationships`, runtime);
  return {
    symbol,
    relationships: result.items,
    pagination: result.pagination,
    evidence: atlas.evidence.filter((item) => evidenceIds.has(item.id)),
  };
}

export async function repositoryOverviewIr(repositoryPath: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const domains = page(atlas.domains, { limit: runtime.maxResultNodes }, "overview:domains", runtime);
  const entrypointIds = new Set(atlas.entrypoint_ids);
  const entrypointSymbols = atlas.symbols.filter((symbol) => entrypointIds.has(symbol.id));
  const entrypoints = page(entrypointSymbols, { limit: runtime.maxResultNodes }, "overview:entrypoints", runtime);
  return {
    schema_version: atlas.schema_version,
    project: atlas.project,
    snapshot: atlas.snapshot,
    statistics: atlas.statistics,
    domains: domains.items.map((domain) => ({
      id: domain.id, name: domain.name, members: domain.member_ids.length, entrypoints: domain.entrypoint_ids.length,
    })),
    entrypoints: entrypoints.items,
    pagination: { domains: domains.pagination, entrypoints: entrypoints.pagination },
  };
}

export async function neighborhoodIr(
  repositoryPath: string,
  target: string,
  direction: "outgoing" | "incoming",
  limit: number,
  cursor?: string,
) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const symbol = resolve(atlas, target);
  const matches = atlas.relationships.filter((edge) =>
    direction === "outgoing" ? edge.source === symbol.id : edge.target === symbol.id,
  );
  const result = page(
    matches,
    { limit, ...(cursor === undefined ? {} : { cursor }) },
    `neighborhood:${direction}:${symbol.id}`,
    runtime,
  );
  const relationships = result.items;
  const ids = new Set(relationships.map((edge) => direction === "outgoing" ? edge.target : edge.source));
  return {
    symbol,
    direction,
    relationships,
    symbols: atlas.symbols.filter((item) => ids.has(item.id)),
    pagination: result.pagination,
  };
}

export async function tracePathIr(repositoryPath: string, from: string, to: string, depth: number) {
  const runtime = await loadIrRuntime(repositoryPath);
  validateDepth(depth, runtime.maxCallDepth, "depth");
  const atlas = runtime.atlas;
  const source = resolve(atlas, from);
  const target = resolve(atlas, to);
  const outgoing = new Map<string, Atlas["relationships"]>();
  for (const edge of atlas.relationships) {
    if (["CONTAINS", "BELONGS_TO_DOMAIN", "BELONGS_TO_FEATURE"].includes(edge.type)) continue;
    const edges = outgoing.get(edge.source) ?? [];
    edges.push(edge);
    outgoing.set(edge.source, edges);
  }
  const queue = [{ id: source.id, symbols: [source.id], relationships: [] as string[] }];
  const visited = new Set([source.id]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.id === target.id) return { source, target, path: current };
    if (current.relationships.length >= depth) continue;
    for (const edge of outgoing.get(current.id) ?? []) {
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      queue.push({
        id: edge.target,
        symbols: [...current.symbols, edge.target],
        relationships: [...current.relationships, edge.id],
      });
    }
  }
  return { source, target, path: null };
}

export async function impactIr(repositoryPath: string, target: string, depth: number, limit: number) {
  const runtime = await loadIrRuntime(repositoryPath);
  validateDepth(depth, runtime.maxImpactDepth, "impact depth");
  if (limit > runtime.maxResultNodes) {
    throw new CodeAtlasError(`Requested limit exceeds config.limits.maxMcpResultNodes (${runtime.maxResultNodes}).`);
  }
  const atlas = runtime.atlas;
  const symbol = resolve(atlas, target);
  return {
    symbol,
    ...describeImpact(atlas, symbol.id, { depth, limit }),
  };
}

export async function flowIr(repositoryPath: string, target: string) {
  const atlas = (await loadIrRuntime(repositoryPath)).atlas;
  const symbol = resolve(atlas, target);
  return { flow: atlas.flows.find((flow) => flow.entrypoint_id === symbol.id || flow.id === target) ?? null };
}

export async function controlFlowIr(repositoryPath: string, target: string) {
  const atlas = (await loadIrRuntime(repositoryPath)).atlas;
  const symbol = resolve(atlas, target);
  return { symbol, control_flow: atlas.control_flows.find((flow) => flow.symbol_id === symbol.id) ?? null };
}

export async function evidenceIr(repositoryPath: string, target: string) {
  const atlas = (await loadIrRuntime(repositoryPath)).atlas;
  const direct = atlas.evidence.find((evidence) => evidence.id === target);
  if (direct !== undefined) return { evidence: [direct] };
  const symbol = resolve(atlas, target);
  const ids = new Set(symbol.evidence_ids);
  return { symbol, evidence: atlas.evidence.filter((evidence) => ids.has(evidence.id)) };
}

export async function domainsIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const result = page(runtime.atlas.domains, { limit, ...(cursor === undefined ? {} : { cursor }) }, "domains", runtime);
  return { domains: result.items, pagination: result.pagination };
}

export async function domainIr(repositoryPath: string, target: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const needle = target.toLocaleLowerCase();
  const domain = atlas.domains.find((item) => item.id === target || item.name.toLocaleLowerCase() === needle);
  if (domain === undefined) throw new Error(`Domain not found: ${target}`);
  const members = new Set(domain.member_ids);
  const result = page(
    atlas.symbols.filter((symbol) => members.has(symbol.id)),
    { limit, ...(cursor === undefined ? {} : { cursor }) },
    `domain:${domain.id}`,
    runtime,
  );
  return { domain, symbols: result.items, pagination: result.pagination };
}

export async function entrypointsIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const atlas = runtime.atlas;
  const ids = new Set(atlas.entrypoint_ids);
  const entries = atlas.symbols.filter((symbol) => ids.has(symbol.id));
  const result = page(entries, { limit, ...(cursor === undefined ? {} : { cursor }) }, "entrypoints", runtime);
  const visibleIds = new Set(result.items.map((symbol) => symbol.id));
  return {
    entrypoints: result.items,
    flows: atlas.flows.filter((flow) => visibleIds.has(flow.entrypoint_id)),
    pagination: result.pagination,
  };
}

export async function changesIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const result = page(runtime.atlas.git_changes, { limit, ...(cursor === undefined ? {} : { cursor }) }, "git_changes", runtime);
  return { changes: result.items, pagination: result.pagination };
}

export async function rulesIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const rules = page(runtime.atlas.rules, { limit, ...(cursor === undefined ? {} : { cursor }) }, "rules", runtime);
  return { rules: rules.items, pagination: rules.pagination };
}

export async function ruleViolationsIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const violations = page(
    runtime.atlas.rule_violations,
    { limit, ...(cursor === undefined ? {} : { cursor }) },
    "rule_violations",
    runtime,
  );
  return { violations: violations.items, pagination: violations.pagination };
}

export async function reviewIr(repositoryPath: string, limit = 100, cursor?: string) {
  const runtime = await loadIrRuntime(repositoryPath);
  const findings = page(runtime.atlas.review_findings, { limit, ...(cursor === undefined ? {} : { cursor }) }, "review_findings", runtime);
  return { findings: findings.items, pagination: findings.pagination };
}

export const SNAPSHOT_SECTIONS = [
  "summary",
  "symbols",
  "relationships",
  "evidence",
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
    return {
      snapshot,
      section,
      items: [],
      pagination: { limit: 0, returned: 0, total: 0, cursor: null, has_more: false },
    };
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
  return { snapshot, section, items: result.items, pagination: result.pagination };
}

export async function compareSnapshotsIr(repositoryPath: string, oldId: string, newId: string) {
  const context = await architectureService.load(repositoryPath);
  return { diff: await compareSnapshots(workspacePaths(context.repositoryRoot).snapshots, oldId, newId) };
}

export function irResult(value: Record<string, unknown>) {
  const enriched = {
    derivation: "canonical_ir",
    ...value,
    next_actions: [
      "Use exact stable IDs from this response in follow-up MCP calls.",
      "Use get_evidence for source-backed details and analyze_impact for blast-radius paths.",
    ],
  };
  const serialized = JSON.stringify(enriched);
  const maximumBytes = 2_000_000;
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > maximumBytes) {
    throw new CodeAtlasError(
      `Canonical-IR response is ${serializedBytes} bytes; reduce the requested limit to stay below ${maximumBytes} bytes.`,
    );
  }
  return {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent: enriched,
  };
}
