import type {
  Atlas,
  AtlasImpactIndex,
  AtlasRelationship,
  ImpactPath,
  ImpactScore,
} from "../ir/models.js";

const NON_IMPACT_EDGES = new Set([
  "CONTAINS",
  "EXPORTS",
  "BELONGS_TO_FEATURE",
  "BELONGS_TO_DOMAIN",
  "RENAMED_FROM",
  "ROUTE_PREFIX",
]);

interface TraversalStep {
  symbolId: string;
  path: string[];
  relationshipIds: string[];
  evidenceIds: string[];
}

function edgeMaps(relationships: readonly AtlasRelationship[]): {
  forward: Map<string, AtlasRelationship[]>;
  reverse: Map<string, AtlasRelationship[]>;
} {
  const forward = new Map<string, AtlasRelationship[]>();
  const reverse = new Map<string, AtlasRelationship[]>();
  for (const relationship of relationships) {
    if (NON_IMPACT_EDGES.has(relationship.type)) continue;
    const outgoing = forward.get(relationship.source) ?? [];
    outgoing.push(relationship);
    forward.set(relationship.source, outgoing);
    const incoming = reverse.get(relationship.target) ?? [];
    incoming.push(relationship);
    reverse.set(relationship.target, incoming);
  }
  const sort = (edges: AtlasRelationship[]): void => {
    edges.sort((left, right) => left.id.localeCompare(right.id));
  };
  for (const edges of forward.values()) sort(edges);
  for (const edges of reverse.values()) sort(edges);
  return { forward, reverse };
}

export function analyzeImpact(
  atlas: Atlas,
  changedSymbolId: string,
  options: { depth?: number; limit?: number } = {},
): ImpactPath[] {
  return createImpactAnalyzer(atlas)(changedSymbolId, options);
}

export function createImpactAnalyzer(atlas: Atlas): (
  changedSymbolId: string,
  options?: { depth?: number; limit?: number },
) => ImpactPath[] {
  const { reverse } = edgeMaps(atlas.relationships);
  return (changedSymbolId, options = {}) => traverseImpact(
    reverse,
    changedSymbolId,
    Math.max(1, Math.min(options.depth ?? 8, 30)),
    Math.max(1, Math.min(options.limit ?? 200, 2_000)),
  );
}

function traverseImpact(
  reverse: ReadonlyMap<string, AtlasRelationship[]>,
  changedSymbolId: string,
  depth: number,
  limit: number,
): ImpactPath[] {
  const queue: TraversalStep[] = [{
    symbolId: changedSymbolId,
    path: [changedSymbolId],
    relationshipIds: [],
    evidenceIds: [],
  }];
  const visited = new Set([changedSymbolId]);
  const results: ImpactPath[] = [];
  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()!;
    if (current.path.length > depth) continue;
    for (const relationship of reverse.get(current.symbolId) ?? []) {
      if (visited.has(relationship.source)) continue;
      visited.add(relationship.source);
      const next: TraversalStep = {
        symbolId: relationship.source,
        path: [...current.path, relationship.source],
        relationshipIds: [...current.relationshipIds, relationship.id],
        evidenceIds: [...new Set([...current.evidenceIds, ...relationship.evidence_ids])],
      };
      results.push({
        changed: changedSymbolId,
        impacted: relationship.source,
        distance: next.path.length - 1,
        path: next.path,
        relationship_ids: next.relationshipIds,
        evidence_ids: next.evidenceIds,
      });
      queue.push(next);
      if (results.length >= limit) break;
    }
  }
  return results;
}

export function buildImpactIndex(atlas: Atlas): AtlasImpactIndex {
  const { forward, reverse } = edgeMaps(atlas.relationships);
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const entrypoints = new Set(atlas.entrypoint_ids);
  const scores: ImpactScore[] = [];
  const scoreCandidates = atlas.symbols.filter((symbol) =>
    !["repository", "directory", "domain", "feature"].includes(symbol.kind),
  );
  for (const symbol of scoreCandidates) {
    const paths = traverseImpact(reverse, symbol.id, 8, 500);
    const impactedIds = new Set(paths.map((path) => path.impacted));
    const affectedEntrypoints = [...impactedIds].filter((id) => entrypoints.has(id)).length;
    const domains = new Set<string>();
    for (const id of impactedIds) {
      for (const domain of symbolById.get(id)?.domain_ids ?? []) domains.add(domain);
    }
    const ownDomains = new Set(symbol.domain_ids);
    const crossDomain = [...domains].some((domain) => !ownDomains.has(domain));
    const directCallers = (reverse.get(symbol.id) ?? []).length;
    const rawScore =
      directCallers * 5 +
      Math.min(paths.length, 40) +
      affectedEntrypoints * 12 +
      Math.max(0, domains.size - ownDomains.size) * 8 +
      (crossDomain ? 10 : 0);
    const score = Math.max(0, Math.min(100, Math.round(rawScore)));
    const reasons = [
      directCallers > 0 ? `${directCallers} direct dependents` : null,
      paths.length > 0 ? `${paths.length} transitive dependents` : null,
      affectedEntrypoints > 0 ? `affects ${affectedEntrypoints} entrypoints` : null,
      domains.size > 0 ? `reaches ${domains.size} domains` : null,
      crossDomain ? "cross-domain impact" : null,
    ].filter((reason): reason is string => reason !== null);
    scores.push({
      symbol_id: symbol.id,
      score,
      risk: score >= 60 ? "high" : score >= 25 ? "medium" : "low",
      direct_callers: directCallers,
      transitive_reach: paths.length,
      affected_entrypoints: affectedEntrypoints,
      affected_domains: domains.size,
      cross_domain: crossDomain,
      reasons,
    });
  }
  return {
    forward: Object.fromEntries([...forward].map(([id, edges]) => [id, edges.map((edge) => edge.target)])),
    reverse: Object.fromEntries([...reverse].map(([id, edges]) => [id, edges.map((edge) => edge.source)])),
    scores,
  };
}
