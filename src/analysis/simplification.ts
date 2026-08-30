import type { Atlas, AtlasRelationship, AtlasSymbol } from "../ir/models.js";

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
}

export interface GraphProjection {
  level: "domain" | "module" | "symbol";
  nodes: GraphProjectionNode[];
  edges: GraphProjectionEdge[];
  hidden_node_count: number;
  truncated: boolean;
}

function aggregateEdges(
  relationships: readonly AtlasRelationship[],
  groupBySymbol: ReadonlyMap<string, string>,
): GraphProjectionEdge[] {
  const groups = new Map<string, GraphProjectionEdge>();
  for (const relationship of relationships) {
    const source = groupBySymbol.get(relationship.source);
    const target = groupBySymbol.get(relationship.target);
    if (source === undefined || target === undefined || source === target) continue;
    const key = `${source}\0${target}`;
    const group = groups.get(key) ?? { source, target, count: 0, relationship_ids: [] };
    group.count += 1;
    group.relationship_ids.push(relationship.id);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    right.count - left.count || `${left.source}:${left.target}`.localeCompare(`${right.source}:${right.target}`),
  );
}

export function buildDefaultProjection(atlas: Atlas, budget = 150): GraphProjection {
  if (atlas.domains.length > 0) {
    const groupBySymbol = new Map<string, string>();
    const nodes = atlas.domains.map((domain) => {
      for (const memberId of domain.member_ids) groupBySymbol.set(memberId, domain.id);
      return {
        id: domain.id,
        kind: "domain",
        name: domain.name,
        member_ids: domain.member_ids,
        count: domain.member_ids.length,
      };
    }).slice(0, budget);
    const visible = new Set(nodes.map((node) => node.id));
    const edges = aggregateEdges(atlas.relationships, groupBySymbol)
      .filter((edge) => visible.has(edge.source) && visible.has(edge.target));
    return {
      level: "domain",
      nodes,
      edges,
      hidden_node_count: Math.max(0, atlas.symbols.length - nodes.length),
      truncated: atlas.domains.length > budget,
    };
  }
  const modules = atlas.symbols.filter((symbol) => symbol.kind === "module").slice(0, budget);
  const groupBySymbol = new Map<string, string>();
  for (const symbol of atlas.symbols) {
    const owner = modules.find((module) => module.file !== null && module.file === symbol.file);
    if (owner !== undefined) groupBySymbol.set(symbol.id, owner.id);
  }
  return {
    level: "module",
    nodes: modules.map((module): GraphProjectionNode => ({
      id: module.id,
      kind: module.kind,
      name: module.name,
      member_ids: atlas.symbols.filter((symbol) => symbol.file === module.file).map((symbol) => symbol.id),
      count: atlas.symbols.filter((symbol) => symbol.file === module.file).length,
    })),
    edges: aggregateEdges(atlas.relationships, groupBySymbol),
    hidden_node_count: Math.max(0, atlas.symbols.length - modules.length),
    truncated: atlas.symbols.filter((symbol) => symbol.kind === "module").length > budget,
  };
}

export function symbolSearchText(symbol: AtlasSymbol): string {
  return [symbol.name, symbol.qualified_name, symbol.file, symbol.kind, ...symbol.domain_ids]
    .filter((value): value is string => value !== null)
    .join(" ").toLocaleLowerCase();
}
