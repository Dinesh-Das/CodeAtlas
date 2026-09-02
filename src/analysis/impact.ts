import type {
  Atlas,
  AtlasImpactIndex,
  AtlasRelationship,
  AtlasSymbol,
  ImpactResult,
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
  confidence: number;
  potentialUsed: boolean;
}

function edgeMaps(relationships: readonly AtlasRelationship[]): {
  forward: Map<string, AtlasRelationship[]>;
  reverse: Map<string, AtlasRelationship[]>;
} {
  const forward = new Map<string, AtlasRelationship[]>();
  const reverse = new Map<string, AtlasRelationship[]>();
  for (const relationship of relationships) {
    if (!isDefiniteImpactRelationship(relationship)) continue;
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

export function isDefiniteImpactRelationship(relationship: AtlasRelationship): boolean {
  return !NON_IMPACT_EDGES.has(relationship.type) &&
    relationship.confidence >= 0.95 &&
    relationship.fact_class !== "INFERRED" &&
    !["HEURISTIC", "EMBEDDING", "LLM"].includes(relationship.provenance);
}

export function isPotentialImpactRelationship(relationship: AtlasRelationship): boolean {
  return !NON_IMPACT_EDGES.has(relationship.type) && !isDefiniteImpactRelationship(relationship);
}

function potentialEdgeMaps(relationships: readonly AtlasRelationship[]): {
  forward: Map<string, AtlasRelationship[]>;
  reverse: Map<string, AtlasRelationship[]>;
} {
  const forward = new Map<string, AtlasRelationship[]>();
  const reverse = new Map<string, AtlasRelationship[]>();
  for (const relationship of relationships) {
    if (!isPotentialImpactRelationship(relationship)) continue;
    const outgoing = forward.get(relationship.source) ?? [];
    outgoing.push(relationship);
    forward.set(relationship.source, outgoing);
    const incoming = reverse.get(relationship.target) ?? [];
    incoming.push(relationship);
    reverse.set(relationship.target, incoming);
  }
  for (const edges of [...forward.values(), ...reverse.values()]) {
    edges.sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
  }
  return { forward, reverse };
}

function allImpactEdgeMaps(relationships: readonly AtlasRelationship[]): {
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
  for (const edges of [...forward.values(), ...reverse.values()]) {
    edges.sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
  }
  return { forward, reverse };
}

function isTestSymbol(symbol: AtlasSymbol | undefined): boolean {
  return symbol?.kind === "test" || (symbol?.file !== null && symbol?.file !== undefined &&
    /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[^/]+$/iu.test(symbol.file));
}

function isDatabaseSymbol(symbol: AtlasSymbol | undefined): boolean {
  return symbol !== undefined && ["database", "table", "schema", "database_table", "db_table"]
    .includes(symbol.kind.toLocaleLowerCase());
}

export function analyzeImpact(
  atlas: Atlas,
  changedSymbolId: string,
  options: { depth?: number; limit?: number } = {},
): ImpactPath[] {
  return createImpactAnalyzer(atlas)(changedSymbolId, options);
}

export function analyzePotentialImpact(
  atlas: Atlas,
  changedSymbolId: string,
  options: { depth?: number; limit?: number } = {},
): ImpactPath[] {
  const { reverse } = allImpactEdgeMaps(atlas.relationships);
  return traverseImpact(
    reverse,
    changedSymbolId,
    Math.max(1, Math.min(options.depth ?? 8, 30)),
    Math.max(1, Math.min(options.limit ?? 200, 2_000)),
    "potential",
    true,
  );
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
  classification: "definite" | "potential" = "definite",
  requirePotential = false,
): ImpactPath[] {
  const queue: TraversalStep[] = [{
    symbolId: changedSymbolId,
    path: [changedSymbolId],
    relationshipIds: [],
    evidenceIds: [],
    confidence: 1,
    potentialUsed: false,
  }];
  const results: ImpactPath[] = [];
  let traversed = 0;
  while (queue.length > 0 && results.length < limit && traversed < limit * 50) {
    const current = queue.shift()!;
    if (current.path.length > depth) continue;
    for (const relationship of reverse.get(current.symbolId) ?? []) {
      if (current.path.includes(relationship.source)) continue;
      traversed += 1;
      const next: TraversalStep = {
        symbolId: relationship.source,
        path: [...current.path, relationship.source],
        relationshipIds: [...current.relationshipIds, relationship.id],
        evidenceIds: [...new Set([...current.evidenceIds, ...relationship.evidence_ids])],
        confidence: Math.min(current.confidence, relationship.confidence),
        potentialUsed: current.potentialUsed || isPotentialImpactRelationship(relationship),
      };
      if (!requirePotential || next.potentialUsed) {
        results.push({
          changed: changedSymbolId,
          impacted: relationship.source,
          distance: next.path.length - 1,
          path: next.path,
          relationship_ids: next.relationshipIds,
          evidence_ids: next.evidenceIds,
          classification,
          confidence: next.confidence,
        });
      }
      queue.push(next);
      if (results.length >= limit) break;
    }
  }
  return results;
}

function traverseDependencies(
  forward: ReadonlyMap<string, AtlasRelationship[]>,
  changedSymbolId: string,
  depth: number,
  limit: number,
  classification: "definite" | "potential" = "definite",
  requirePotential = false,
): ImpactPath[] {
  const queue: TraversalStep[] = [{
    symbolId: changedSymbolId,
    path: [changedSymbolId],
    relationshipIds: [],
    evidenceIds: [],
    confidence: 1,
    potentialUsed: false,
  }];
  const results: ImpactPath[] = [];
  let traversed = 0;
  while (queue.length > 0 && results.length < limit && traversed < limit * 50) {
    const current = queue.shift()!;
    if (current.path.length > depth) continue;
    for (const relationship of forward.get(current.symbolId) ?? []) {
      if (current.path.includes(relationship.target)) continue;
      traversed += 1;
      const next: TraversalStep = {
        symbolId: relationship.target,
        path: [...current.path, relationship.target],
        relationshipIds: [...current.relationshipIds, relationship.id],
        evidenceIds: [...new Set([...current.evidenceIds, ...relationship.evidence_ids])],
        confidence: Math.min(current.confidence, relationship.confidence),
        potentialUsed: current.potentialUsed || isPotentialImpactRelationship(relationship),
      };
      if (!requirePotential || next.potentialUsed) {
        results.push({
          changed: changedSymbolId,
          impacted: relationship.target,
          distance: next.path.length - 1,
          path: next.path,
          relationship_ids: next.relationshipIds,
          evidence_ids: next.evidenceIds,
          classification,
          confidence: next.confidence,
        });
      }
      queue.push(next);
      if (results.length >= limit) break;
    }
  }
  return results;
}

export function describeImpact(
  atlas: Atlas,
  changedSymbolId: string,
  options: { depth?: number; limit?: number } = {},
): ImpactResult {
  const depth = Math.max(1, Math.min(options.depth ?? 8, 30));
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2_000));
  const { forward, reverse } = edgeMaps(atlas.relationships);
  const potential = potentialEdgeMaps(atlas.relationships);
  const allImpact = allImpactEdgeMaps(atlas.relationships);
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const paths = traverseImpact(reverse, changedSymbolId, depth, limit);
  const dependencyPaths = traverseDependencies(forward, changedSymbolId, depth, limit);
  const potentialPaths = traverseImpact(
    allImpact.reverse,
    changedSymbolId,
    depth,
    limit,
    "potential",
    true,
  );
  const potentialDependencyPaths = traverseDependencies(
    allImpact.forward,
    changedSymbolId,
    depth,
    limit,
    "potential",
    true,
  );
  const impactedIds = new Set([changedSymbolId, ...paths.map((path) => path.impacted)]);
  const impactedSymbols = [...impactedIds].map((id) => symbolById.get(id)).filter((item): item is AtlasSymbol => item !== undefined);
  const affectedDomains = new Set(impactedSymbols.flatMap((symbol) => symbol.domain_ids));
  const affectedFiles = new Set(impactedSymbols.map((symbol) => symbol.file).filter((file): file is string => file !== null));
  const affectedEntrypoints = atlas.entrypoint_ids.filter((id) => impactedIds.has(id));
  const affectedApis = affectedEntrypoints.filter((id) => symbolById.get(id)?.kind === "endpoint");
  const affectedTests = impactedSymbols.filter((symbol) => isTestSymbol(symbol)).map((symbol) => symbol.id);
  const affectedRules = atlas.rule_violations.filter((violation) =>
    impactedIds.has(violation.source_id) ||
    (violation.target_id !== null && impactedIds.has(violation.target_id)) ||
    violation.path.some((id) => impactedIds.has(id)),
  ).map((violation) => violation.id);
  return {
    changed: changedSymbolId,
    direct_callers: [...new Set((reverse.get(changedSymbolId) ?? [])
      .filter((edge) => edge.type === "CALLS")
      .map((edge) => edge.source))],
    direct_dependents: [...new Set((reverse.get(changedSymbolId) ?? []).map((edge) => edge.source))],
    direct_dependencies: [...new Set((forward.get(changedSymbolId) ?? []).map((edge) => edge.target))],
    potential_direct_dependents: [...new Set((potential.reverse.get(changedSymbolId) ?? [])
      .map((edge) => edge.source))],
    potential_direct_dependencies: [...new Set((potential.forward.get(changedSymbolId) ?? [])
      .map((edge) => edge.target))],
    transitive_callers: [...new Set(paths.map((path) => path.impacted))],
    transitive_dependencies: [...new Set(dependencyPaths.map((path) => path.impacted))],
    affected_files: [...affectedFiles].sort((left, right) => left.localeCompare(right)),
    affected_domains: [...affectedDomains].sort((left, right) => left.localeCompare(right)),
    affected_entrypoints: affectedEntrypoints,
    affected_apis: affectedApis,
    affected_tests: [...new Set(affectedTests)],
    affected_rules: [...new Set(affectedRules)],
    paths,
    dependency_paths: dependencyPaths,
    potential_paths: potentialPaths,
    potential_dependency_paths: potentialDependencyPaths,
    score: atlas.impact.scores.find((score) => score.symbol_id === changedSymbolId) ?? null,
  };
}

function logarithmicContribution(value: number, weight: number, maximum: number): number {
  return Number(Math.min(maximum, Math.log2(value + 1) * weight).toFixed(2));
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
    const affectedApis = [...impactedIds].filter((id) => symbolById.get(id)?.kind === "endpoint").length;
    const affectedTests = [...impactedIds].filter((id) => isTestSymbol(symbolById.get(id))).length;
    const domains = new Set<string>();
    for (const id of impactedIds) {
      for (const domain of symbolById.get(id)?.domain_ids ?? []) domains.add(domain);
    }
    const ownDomains = new Set(symbol.domain_ids);
    const crossedDomains = [...domains].filter((domain) => !ownDomains.has(domain)).length;
    const crossDomain = crossedDomains > 0;
    const directCallers = (reverse.get(symbol.id) ?? [])
      .filter((edge) => edge.type === "CALLS")
      .length;
    const centrality = new Set([
      ...(forward.get(symbol.id) ?? []).map((edge) => edge.target),
      ...(reverse.get(symbol.id) ?? []).map((edge) => edge.source),
    ]).size;
    const databaseSchemaImpact = isDatabaseSymbol(symbol) || (forward.get(symbol.id) ?? []).some((edge) =>
      isDatabaseSymbol(symbolById.get(edge.target)) || ["READS_FROM", "WRITES_TO"].includes(edge.type),
    );
    const ruleIds = new Set(atlas.rule_violations.filter((violation) =>
      violation.source_id === symbol.id ||
      violation.target_id === symbol.id ||
      violation.path.some((id) => impactedIds.has(id)),
    ).map((violation) => violation.rule_id));
    const components = {
      direct_callers: { value: directCallers, weight: 5, contribution: logarithmicContribution(directCallers, 5, 20) },
      transitive_reach: { value: paths.length, weight: 2.2, contribution: logarithmicContribution(paths.length, 2.2, 20) },
      affected_entrypoints: { value: affectedEntrypoints, weight: 10, contribution: logarithmicContribution(affectedEntrypoints, 10, 20) },
      cross_domain: { value: crossedDomains, weight: 4, contribution: logarithmicContribution(crossedDomains, 4, 10) },
      public_api: { value: affectedApis, weight: 5, contribution: logarithmicContribution(affectedApis, 5, 10) },
      database_schema: { value: databaseSchemaImpact ? 1 : 0, weight: 8, contribution: databaseSchemaImpact ? 8 : 0 },
      missing_test_coverage: { value: paths.length > 0 && affectedTests === 0 ? 1 : 0, weight: 8, contribution: paths.length > 0 && affectedTests === 0 ? 8 : 0 },
      centrality: { value: centrality, weight: 1.5, contribution: logarithmicContribution(centrality, 1.5, 8) },
      architecture_rules: { value: ruleIds.size, weight: 5, contribution: logarithmicContribution(ruleIds.size, 5, 10) },
    };
    const rawScore = Object.values(components).reduce((sum, factor) => sum + factor.contribution, 0);
    const score = Math.max(0, Math.min(100, Number(rawScore.toFixed(1))));
    const reasons = [
      directCallers > 0 ? `${directCallers} direct dependents` : null,
      paths.length > 0 ? `${paths.length} transitive dependents` : null,
      affectedEntrypoints > 0 ? `affects ${affectedEntrypoints} entrypoints` : null,
      domains.size > 0 ? `reaches ${domains.size} domains` : null,
      crossDomain ? "cross-domain impact" : null,
      affectedApis > 0 ? `affects ${affectedApis} public API endpoints` : null,
      databaseSchemaImpact ? "touches a database/schema dependency" : null,
      paths.length > 0 && affectedTests === 0 ? "no affected tests were detected" : null,
      affectedTests > 0 ? `${affectedTests} affected tests detected` : null,
      centrality > 0 ? `dependency centrality ${centrality}` : null,
      ruleIds.size > 0 ? `intersects ${ruleIds.size} architecture-rule violations` : null,
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
      affected_apis: affectedApis,
      affected_tests: affectedTests,
      affected_rules: ruleIds.size,
      database_schema_impact: databaseSchemaImpact,
      centrality,
      components,
      reasons,
    });
  }
  return {
    forward: Object.fromEntries([...forward].map(([id, edges]) => [id, edges.map((edge) => edge.target)])),
    reverse: Object.fromEntries([...reverse].map(([id, edges]) => [id, edges.map((edge) => edge.source)])),
    scores,
  };
}
