import {
  rankSymbolSearch,
  symbolSearchText,
  symbolSearchTerms,
} from "../analysis/simplification.js";
import type {
  Atlas,
  AtlasControlFlow,
  AtlasEvidence,
  AtlasRelationship,
  AtlasResolutionIssue,
  AtlasSymbol,
} from "../ir/models.js";

export interface AtlasProjection {
  symbolById: ReadonlyMap<string, AtlasSymbol>;
  evidenceById: ReadonlyMap<string, AtlasEvidence>;
  relationshipById: ReadonlyMap<string, AtlasRelationship>;
  outgoingBySymbolId: ReadonlyMap<string, readonly AtlasRelationship[]>;
  incomingBySymbolId: ReadonlyMap<string, readonly AtlasRelationship[]>;
  symbolsByName: ReadonlyMap<string, readonly AtlasSymbol[]>;
  symbolsByQualifiedName: ReadonlyMap<string, readonly AtlasSymbol[]>;
  resolutionIssuesBySymbolId: ReadonlyMap<string, readonly AtlasResolutionIssue[]>;
  controlFlowBySymbolId: ReadonlyMap<string, AtlasControlFlow>;
  searchTextBySymbolId: ReadonlyMap<string, string>;
  symbolIdsBySearchTerm: ReadonlyMap<string, readonly string[]>;
  registerControlFlow(flow: AtlasControlFlow): void;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function readonlyArrays<K, V>(map: Map<K, V[]>): ReadonlyMap<K, readonly V[]> {
  for (const values of map.values()) Object.freeze(values);
  return map;
}

export function createAtlasProjection(atlas: Atlas): AtlasProjection {
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const evidenceById = new Map(atlas.evidence.map((evidence) => [evidence.id, evidence]));
  const relationshipById = new Map(atlas.relationships.map((relationship) => [relationship.id, relationship]));
  const domainById = new Map(atlas.domains.map((domain) => [domain.id, domain]));
  const outgoingBySymbolId = new Map<string, AtlasRelationship[]>();
  const incomingBySymbolId = new Map<string, AtlasRelationship[]>();
  const symbolsByName = new Map<string, AtlasSymbol[]>();
  const symbolsByQualifiedName = new Map<string, AtlasSymbol[]>();
  const resolutionIssuesBySymbolId = new Map<string, AtlasResolutionIssue[]>();
  const controlFlowBySymbolId = new Map(atlas.control_flows.map((flow) => [flow.symbol_id, flow]));
  const searchTextBySymbolId = new Map<string, string>();
  const symbolIdsBySearchTerm = new Map<string, string[]>();

  for (const relationship of atlas.relationships) {
    push(outgoingBySymbolId, relationship.source, relationship);
    push(incomingBySymbolId, relationship.target, relationship);
  }
  for (const issue of atlas.resolution_issues) {
    push(resolutionIssuesBySymbolId, issue.source_id, issue);
    for (const candidateId of issue.candidate_ids) push(resolutionIssuesBySymbolId, candidateId, issue);
  }
  for (const symbol of atlas.symbols) {
    push(symbolsByName, symbol.name.toLocaleLowerCase(), symbol);
    if (symbol.qualified_name !== null) {
      push(symbolsByQualifiedName, symbol.qualified_name.toLocaleLowerCase(), symbol);
    }
    const text = symbolSearchText(symbol, {
      domainById,
      evidenceById,
    });
    searchTextBySymbolId.set(symbol.id, text);
    for (const term of symbolSearchTerms(text)) push(symbolIdsBySearchTerm, term, symbol.id);
  }

  return {
    symbolById,
    evidenceById,
    relationshipById,
    outgoingBySymbolId: readonlyArrays(outgoingBySymbolId),
    incomingBySymbolId: readonlyArrays(incomingBySymbolId),
    symbolsByName: readonlyArrays(symbolsByName),
    symbolsByQualifiedName: readonlyArrays(symbolsByQualifiedName),
    resolutionIssuesBySymbolId: readonlyArrays(resolutionIssuesBySymbolId),
    controlFlowBySymbolId,
    searchTextBySymbolId,
    symbolIdsBySearchTerm: readonlyArrays(symbolIdsBySearchTerm),
    registerControlFlow(flow): void {
      if (!controlFlowBySymbolId.has(flow.symbol_id)) {
        atlas.control_flows.push(flow);
        atlas.control_flows.sort((left, right) => left.id.localeCompare(right.id));
        atlas.statistics.control_flows = atlas.control_flows.length;
      }
      controlFlowBySymbolId.set(flow.symbol_id, flow);
      for (const node of flow.nodes) {
        for (const evidenceId of node.evidence_ids) {
          const evidence = atlas.evidence.find((item) => item.id === evidenceId);
          if (evidence !== undefined) evidenceById.set(evidenceId, evidence);
        }
      }
    },
  };
}

export function projectionSearchCandidates(
  projection: AtlasProjection,
  query: string,
): AtlasSymbol[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [];
  const terms = symbolSearchTerms(needle);
  const ids = new Set<string>();
  for (const term of terms) {
    for (const id of projection.symbolIdsBySearchTerm.get(term) ?? []) ids.add(id);
  }
  for (const symbol of projection.symbolsByName.get(needle) ?? []) ids.add(symbol.id);
  for (const symbol of projection.symbolsByQualifiedName.get(needle) ?? []) ids.add(symbol.id);

  // The existing ranker supports partial and camel-case terms. FTS narrows the
  // common path; this scan of precomputed strings preserves those semantics
  // without rebuilding evidence text for every query.
  for (const [id, text] of projection.searchTextBySymbolId) {
    if (text.includes(needle) || terms.some((term) => text.includes(term))) ids.add(id);
  }
  return [...ids].flatMap((id) => {
    const symbol = projection.symbolById.get(id);
    return symbol === undefined ? [] : [symbol];
  });
}

export function rankProjectedSymbol(
  projection: AtlasProjection,
  symbol: AtlasSymbol,
  query: string,
): number {
  return rankSymbolSearch(symbol, query, projection.searchTextBySymbolId.get(symbol.id));
}
