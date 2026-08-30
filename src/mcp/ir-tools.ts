import { describeImpact } from "../analysis/impact.js";
import { workspacePaths } from "../core/workspace.js";
import { compareSnapshots, loadSnapshot } from "../git/snapshots.js";
import type { Atlas } from "../ir/models.js";
import { architectureService } from "../service/architecture-service.js";

export async function loadFreshIr(repositoryPath: string): Promise<Atlas> {
  return (await architectureService.load(repositoryPath)).atlas;
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

export async function findSymbolIr(repositoryPath: string, query: string, limit: number) {
  const atlas = await loadFreshIr(repositoryPath);
  const needle = query.toLocaleLowerCase();
  return {
    schema_version: atlas.schema_version,
    derivation: "canonical_ir",
    results: atlas.symbols.filter((symbol) =>
      [symbol.id, symbol.name, symbol.qualified_name, symbol.file, symbol.kind]
        .filter((value): value is string => value !== null)
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    ).slice(0, limit),
  };
}

export async function callersIr(repositoryPath: string, target: string, limit: number) {
  const atlas = await loadFreshIr(repositoryPath);
  const symbol = resolve(atlas, target);
  const relationships = atlas.relationships.filter((edge) =>
    edge.target === symbol.id && ["CALLS", "HANDLES", "TRIGGERS", "MAY_CONTINUE_TO"].includes(edge.type),
  ).slice(0, limit);
  const ids = new Set(relationships.map((edge) => edge.source));
  return {
    symbol,
    direct_callers: relationships.length,
    callers: atlas.symbols.filter((item) => ids.has(item.id)),
    relationships,
  };
}

export async function symbolIr(repositoryPath: string, target: string) {
  const atlas = await loadFreshIr(repositoryPath);
  const symbol = resolve(atlas, target);
  const evidenceIds = new Set(symbol.evidence_ids);
  return {
    symbol,
    relationships: atlas.relationships.filter((edge) => edge.source === symbol.id || edge.target === symbol.id).slice(0, 200),
    evidence: atlas.evidence.filter((item) => evidenceIds.has(item.id)),
  };
}

export async function repositoryOverviewIr(repositoryPath: string) {
  const atlas = await loadFreshIr(repositoryPath);
  return {
    schema_version: atlas.schema_version,
    project: atlas.project,
    snapshot: atlas.snapshot,
    statistics: atlas.statistics,
    domains: atlas.domains.map((domain) => ({
      id: domain.id, name: domain.name, members: domain.member_ids.length, entrypoints: domain.entrypoint_ids.length,
    })),
    entrypoints: atlas.entrypoint_ids.map((id) => atlas.symbols.find((symbol) => symbol.id === id)).filter(Boolean),
  };
}

export async function neighborhoodIr(
  repositoryPath: string,
  target: string,
  direction: "outgoing" | "incoming",
  limit: number,
) {
  const atlas = await loadFreshIr(repositoryPath);
  const symbol = resolve(atlas, target);
  const relationships = atlas.relationships.filter((edge) =>
    direction === "outgoing" ? edge.source === symbol.id : edge.target === symbol.id,
  ).slice(0, limit);
  const ids = new Set(relationships.map((edge) => direction === "outgoing" ? edge.target : edge.source));
  return { symbol, direction, relationships, symbols: atlas.symbols.filter((item) => ids.has(item.id)) };
}

export async function tracePathIr(repositoryPath: string, from: string, to: string, depth: number) {
  const atlas = await loadFreshIr(repositoryPath);
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
  const atlas = await loadFreshIr(repositoryPath);
  const symbol = resolve(atlas, target);
  return {
    symbol,
    ...describeImpact(atlas, symbol.id, { depth, limit }),
  };
}

export async function flowIr(repositoryPath: string, target: string) {
  const atlas = await loadFreshIr(repositoryPath);
  const symbol = resolve(atlas, target);
  return { flow: atlas.flows.find((flow) => flow.entrypoint_id === symbol.id || flow.id === target) ?? null };
}

export async function controlFlowIr(repositoryPath: string, target: string) {
  const atlas = await loadFreshIr(repositoryPath);
  const symbol = resolve(atlas, target);
  return { symbol, control_flow: atlas.control_flows.find((flow) => flow.symbol_id === symbol.id) ?? null };
}

export async function evidenceIr(repositoryPath: string, target: string) {
  const atlas = await loadFreshIr(repositoryPath);
  const direct = atlas.evidence.find((evidence) => evidence.id === target);
  if (direct !== undefined) return { evidence: [direct] };
  const symbol = resolve(atlas, target);
  const ids = new Set(symbol.evidence_ids);
  return { symbol, evidence: atlas.evidence.filter((evidence) => ids.has(evidence.id)) };
}

export async function domainsIr(repositoryPath: string) {
  const atlas = await loadFreshIr(repositoryPath);
  return { domains: atlas.domains };
}

export async function domainIr(repositoryPath: string, target: string) {
  const atlas = await loadFreshIr(repositoryPath);
  const needle = target.toLocaleLowerCase();
  const domain = atlas.domains.find((item) => item.id === target || item.name.toLocaleLowerCase() === needle);
  if (domain === undefined) throw new Error(`Domain not found: ${target}`);
  const members = new Set(domain.member_ids);
  return { domain, symbols: atlas.symbols.filter((symbol) => members.has(symbol.id)).slice(0, 500) };
}

export async function entrypointsIr(repositoryPath: string) {
  const atlas = await loadFreshIr(repositoryPath);
  const ids = new Set(atlas.entrypoint_ids);
  return { entrypoints: atlas.symbols.filter((symbol) => ids.has(symbol.id)), flows: atlas.flows };
}

export async function changesIr(repositoryPath: string) {
  const atlas = await loadFreshIr(repositoryPath);
  return { changes: atlas.git_changes };
}

export async function rulesIr(repositoryPath: string) {
  const atlas = await loadFreshIr(repositoryPath);
  return { rules: atlas.rules, violations: atlas.rule_violations };
}

export async function reviewIr(repositoryPath: string) {
  const atlas = await loadFreshIr(repositoryPath);
  return { findings: atlas.review_findings, changes: atlas.git_changes };
}

export async function snapshotIr(repositoryPath: string, id: string) {
  const context = await architectureService.load(repositoryPath);
  return { snapshot: await loadSnapshot(workspacePaths(context.repositoryRoot).snapshots, id) };
}

export async function compareSnapshotsIr(repositoryPath: string, oldId: string, newId: string) {
  const context = await architectureService.load(repositoryPath);
  return { diff: await compareSnapshots(workspacePaths(context.repositoryRoot).snapshots, oldId, newId) };
}

export function irResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
