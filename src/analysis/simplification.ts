import type { Atlas, AtlasRelationship, AtlasSymbol } from "../ir/models.js";
import { isPrimaryArchitectureSymbol, symbolArchitecturalScope } from "./scope.js";

export const DEFAULT_VISIBLE_NODE_BUDGET = 150;
export const DEFAULT_EXPANDED_NODE_BUDGET = 500;
export const DEFAULT_REPRESENTATIVE_EDGE_LIMIT = 5;

const NON_DEPENDENCY_EDGES = new Set([
  "CONTAINS",
  "EXPORTS",
  "BELONGS_TO_FEATURE",
  "BELONGS_TO_DOMAIN",
  "RENAMED_FROM",
  "ROUTE_PREFIX",
]);

export interface GraphProjectionNode {
  id: string;
  kind: string;
  name: string;
  member_ids: string[];
  count: number;
}

export interface GraphProjectionEdge {
  source: string;
  target: string;
  count: number;
  relationship_ids: string[];
  representative_relationship_ids: string[];
}

export interface GraphProjection {
  level: "domain" | "module" | "symbol";
  nodes: GraphProjectionNode[];
  edges: GraphProjectionEdge[];
  hidden_node_count: number;
  truncated: boolean;
  warnings: string[];
}

export interface GraphHub {
  symbol_id: string;
  degree: number;
  incoming: number;
  outgoing: number;
}

function dependencyRelationship(relationship: AtlasRelationship): boolean {
  return !NON_DEPENDENCY_EDGES.has(relationship.type);
}

function aggregateEdges(
  relationships: readonly AtlasRelationship[],
  groupBySymbol: ReadonlyMap<string, string>,
  representativeLimit = DEFAULT_REPRESENTATIVE_EDGE_LIMIT,
): GraphProjectionEdge[] {
  const groups = new Map<string, AtlasRelationship[]>();
  for (const relationship of relationships) {
    if (!dependencyRelationship(relationship)) continue;
    const source = groupBySymbol.get(relationship.source);
    const target = groupBySymbol.get(relationship.target);
    if (source === undefined || target === undefined || source === target) continue;
    const key = `${source}\0${target}`;
    const group = groups.get(key) ?? [];
    group.push(relationship);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, grouped]) => {
    const separator = key.indexOf("\0");
    const source = key.slice(0, separator);
    const target = key.slice(separator + 1);
    const ranked = [...grouped].sort((left, right) =>
      right.confidence - left.confidence ||
      left.type.localeCompare(right.type) ||
      left.id.localeCompare(right.id),
    );
    return {
      source,
      target,
      count: grouped.length,
      relationship_ids: grouped.map((relationship) => relationship.id)
        .sort((left, right) => left.localeCompare(right)),
      representative_relationship_ids: ranked
        .slice(0, Math.max(1, representativeLimit))
        .map((relationship) => relationship.id),
    };
  }).sort((left, right) =>
    right.count - left.count ||
    `${left.source}:${left.target}`.localeCompare(`${right.source}:${right.target}`),
  );
}

function budgetWarning(level: string, total: number, budget: number): string[] {
  if (total <= budget) return [];
  return [`${level} projection summarized ${total} nodes to the ${budget}-node rendering budget.`];
}

export function buildDefaultProjection(
  atlas: Atlas,
  budget = DEFAULT_VISIBLE_NODE_BUDGET,
): GraphProjection {
  const safeBudget = Math.max(1, budget);
  if (atlas.domains.length > 0) {
    const primaryIds = new Set(atlas.symbols.filter(isPrimaryArchitectureSymbol).map((symbol) => symbol.id));
    const primaryMembers = (domain: Atlas["domains"][number]): string[] =>
      domain.member_ids.filter((id) => primaryIds.has(id));
    const rankedDomains = atlas.domains.filter((domain) => primaryMembers(domain).length > 0)
      .sort((left, right) =>
      primaryMembers(right).length - primaryMembers(left).length || left.id.localeCompare(right.id),
    );
    const nodes = rankedDomains.slice(0, safeBudget).map((domain): GraphProjectionNode => ({
      id: domain.id,
      kind: "domain",
      name: domain.name,
      member_ids: primaryMembers(domain).sort((left, right) => left.localeCompare(right)),
      count: primaryMembers(domain).length,
    }));
    const groupBySymbol = new Map<string, string>();
    for (const domain of rankedDomains) {
      for (const memberId of primaryMembers(domain)) groupBySymbol.set(memberId, domain.id);
    }
    const visible = new Set(nodes.map((node) => node.id));
    return {
      level: "domain",
      nodes,
      edges: aggregateEdges(atlas.relationships, groupBySymbol)
        .filter((edge) => visible.has(edge.source) && visible.has(edge.target)),
      hidden_node_count: atlas.symbols.length,
      truncated: rankedDomains.length > safeBudget,
      warnings: budgetWarning("Production domain", rankedDomains.length, safeBudget),
    };
  }

  const modules = atlas.symbols
    .filter((symbol) => (symbol.kind === "module" || symbol.kind === "file") && isPrimaryArchitectureSymbol(symbol))
    .sort((left, right) => left.id.localeCompare(right.id));
  const visibleModules = modules.slice(0, safeBudget);
  const visibleIds = new Set(visibleModules.map((module) => module.id));
  const moduleByFile = new Map(
    modules.flatMap((module) => module.file === null ? [] : [[module.file, module.id] as const]),
  );
  const groupBySymbol = new Map<string, string>();
  for (const symbol of atlas.symbols) {
    if (symbol.file === null) continue;
    const owner = moduleByFile.get(symbol.file);
    if (owner !== undefined) groupBySymbol.set(symbol.id, owner);
  }
  return {
    level: "module",
    nodes: visibleModules.map((module): GraphProjectionNode => {
      const members = atlas.symbols.filter((symbol) => symbol.file === module.file)
        .map((symbol) => symbol.id)
        .sort((left, right) => left.localeCompare(right));
      return {
        id: module.id,
        kind: module.kind,
        name: module.name,
        member_ids: members,
        count: members.length,
      };
    }),
    edges: aggregateEdges(atlas.relationships, groupBySymbol)
      .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    hidden_node_count: Math.max(0, atlas.symbols.length - visibleModules.length),
    truncated: modules.length > safeBudget,
    warnings: budgetWarning("Module", modules.length, safeBudget),
  };
}

export function detectHighDegreeHubs(
  atlas: Atlas,
  options: { minimumDegree?: number; limit?: number } = {},
): GraphHub[] {
  const degrees = new Map<string, { incoming: number; outgoing: number }>();
  for (const relationship of atlas.relationships) {
    if (!dependencyRelationship(relationship)) continue;
    const source = degrees.get(relationship.source) ?? { incoming: 0, outgoing: 0 };
    source.outgoing += 1;
    degrees.set(relationship.source, source);
    const target = degrees.get(relationship.target) ?? { incoming: 0, outgoing: 0 };
    target.incoming += 1;
    degrees.set(relationship.target, target);
  }
  const defaultMinimum = Math.max(8, Math.ceil(Math.sqrt(Math.max(1, atlas.symbols.length))));
  const minimumDegree = Math.max(1, options.minimumDegree ?? defaultMinimum);
  const limit = Math.max(1, options.limit ?? 100);
  return [...degrees.entries()]
    .map(([symbol_id, counts]) => ({
      symbol_id,
      incoming: counts.incoming,
      outgoing: counts.outgoing,
      degree: counts.incoming + counts.outgoing,
    }))
    .filter((hub) => hub.degree >= minimumDegree)
    .sort((left, right) => right.degree - left.degree || left.symbol_id.localeCompare(right.symbol_id))
    .slice(0, limit);
}

function searchableMetadata(metadata: Readonly<Record<string, unknown>>): string[] {
  return Object.values(metadata).flatMap((value) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return [String(value)];
    }
    if (Array.isArray(value)) {
      return value.filter((item): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      ).map(String);
    }
    return [];
  });
}

export function symbolSearchText(symbol: AtlasSymbol, atlas?: Atlas): string {
  const domainNames = atlas === undefined
    ? []
    : symbol.domain_ids.flatMap((id) => atlas.domains.find((domain) => domain.id === id)?.name ?? []);
  const evidenceText = atlas === undefined
    ? []
    : symbol.evidence_ids.flatMap((id) => atlas.evidence.find((evidence) => evidence.id === id)?.excerpt ?? []);
  return [
    symbol.name,
    symbol.qualified_name,
    symbol.file,
    symbol.kind,
    symbol.signature,
    ...symbol.domain_ids,
    ...domainNames,
    ...searchableMetadata(symbol.metadata),
    ...evidenceText,
  ]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLocaleLowerCase();
}

const SEARCH_KIND_WEIGHT: Readonly<Record<string, number>> = {
  endpoint: 80,
  function: 70,
  method: 68,
  class: 64,
  interface: 56,
  database_model: 56,
  module: 48,
  file: 44,
  domain: 42,
  feature: 40,
  test: 12,
  variable: 0,
};

export function rankSymbolSearch(symbol: AtlasSymbol, query: string, atlas?: Atlas): number {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return 0;
  const name = symbol.name.toLocaleLowerCase();
  const qualified = symbol.qualified_name?.toLocaleLowerCase() ?? "";
  const file = symbol.file?.toLocaleLowerCase() ?? "";
  const text = symbolSearchText(symbol, atlas);
  const terms = [...new Set(needle.split(/[^a-z0-9_]+/u).filter((term) => term.length > 1))];
  if (!text.includes(needle) && !terms.some((term) => text.includes(term))) return 0;
  let score = SEARCH_KIND_WEIGHT[symbol.kind] ?? 24;
  if (name === needle) score += 1_000;
  else if (qualified === needle) score += 900;
  else if (name.startsWith(needle)) score += 500;
  else if (qualified.startsWith(needle)) score += 400;
  else if (name.includes(needle)) score += 300;
  else if (qualified.includes(needle)) score += 220;
  else if (file.includes(needle)) score += 100;
  for (const term of terms) {
    if (name === term) score += 90;
    else if (name.includes(term)) score += 45;
    else if (qualified.includes(term)) score += 28;
    else if (file.includes(term)) score += 16;
    else if (text.includes(term)) score += 6;
  }
  const scope = symbolArchitecturalScope(symbol);
  if (scope === "production") score += 60;
  else if (scope === "configuration") score += 20;
  else if (!["test", "fixture", "example"].some((candidate) => needle.includes(candidate))) score -= 120;
  if (symbol.visibility === "public") score += 15;
  return score;
}
