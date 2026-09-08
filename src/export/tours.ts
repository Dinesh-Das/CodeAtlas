import type { Atlas, AtlasRelationship, AtlasSymbol } from "../ir/models.js";

export interface KnowledgeTourStep {
  symbol_id: string;
  label: string;
  edge_label: string;
  confidence: number;
  fact_class: string;
  evidence_ids: string[];
}

export interface KnowledgeTour {
  id: string;
  title: string;
  purpose: string;
  snapshot_id: string;
  fingerprint: string;
  steps: KnowledgeTourStep[];
  coverage: { summary: string; gaps: string[] };
}

function unique(symbols: readonly (AtlasSymbol | undefined)[], limit = 8): AtlasSymbol[] {
  return [...new Map(symbols.flatMap((symbol) => symbol === undefined ? [] : [[symbol.id, symbol]])).values()]
    .slice(0, limit);
}

function connectingRelationship(
  atlas: Atlas,
  previous: AtlasSymbol | undefined,
  symbol: AtlasSymbol,
): AtlasRelationship | undefined {
  if (previous === undefined) return undefined;
  return atlas.relationships.find((relationship) =>
    relationship.source === previous.id && relationship.target === symbol.id
  ) ?? atlas.relationships.find((relationship) =>
    relationship.target === previous.id && relationship.source === symbol.id
  );
}

function steps(atlas: Atlas, symbols: readonly AtlasSymbol[]): KnowledgeTourStep[] {
  return symbols.map((symbol, index) => {
    const relationship = connectingRelationship(atlas, symbols[index - 1], symbol);
    return {
      symbol_id: symbol.id,
      label: symbol.qualified_name ?? symbol.name,
      edge_label: relationship?.type ?? (index === 0 ? "STARTS_AT" : "RELATED_COMPONENT"),
      confidence: relationship?.confidence ?? symbol.confidence,
      fact_class: relationship?.fact_class ?? symbol.fact_class,
      evidence_ids: relationship?.evidence_ids.length
        ? relationship.evidence_ids
        : symbol.evidence_ids,
    };
  });
}

function tour(
  atlas: Atlas,
  id: string,
  title: string,
  purpose: string,
  symbols: readonly AtlasSymbol[],
  expected: number,
): KnowledgeTour {
  const selected = unique(symbols);
  const missingEvidence = selected.filter((symbol) => symbol.evidence_ids.length === 0);
  const gaps = [
    ...(selected.length < expected ? [`Only ${selected.length} of ${expected} expected architecture steps were detected.`] : []),
    ...(missingEvidence.length > 0 ? [`${missingEvidence.length} steps have no direct source evidence.`] : []),
  ];
  return {
    id,
    title,
    purpose,
    snapshot_id: atlas.snapshot.id,
    fingerprint: atlas.snapshot.id.startsWith("worktree-")
      ? atlas.snapshot.id.slice("worktree-".length)
      : atlas.project.git_commit ?? atlas.snapshot.id,
    steps: steps(atlas, selected),
    coverage: {
      summary: `${selected.length} evidence-linked architecture steps; ${gaps.length} coverage gaps.`,
      gaps,
    },
  };
}

function symbolsMatching(atlas: Atlas, pattern: RegExp): AtlasSymbol[] {
  return atlas.symbols.filter((symbol) => pattern.test(
    `${symbol.kind} ${symbol.name} ${symbol.qualified_name ?? ""} ${symbol.file ?? ""}`,
  ));
}

export function buildKnowledgeTours(atlas: Atlas): KnowledgeTour[] {
  const byId = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const entrypoints = atlas.entrypoint_ids.flatMap((id) => byId.get(id) ?? []);
  const primaryFlow = [...atlas.flows].sort((left, right) => right.steps.length - left.steps.length)[0];
  const flowSymbols = primaryFlow?.steps.flatMap((step) => byId.get(step.symbol_id) ?? []) ?? [];
  const storage = symbolsMatching(atlas, /\b(?:database|datastore|model|repository|sqlite|storage|store|persist|query)\b/iu);
  const interfaces = symbolsMatching(atlas, /\b(?:cli|command|controller|endpoint|handler|mcp|route|server)\b/iu);
  const tests = atlas.symbols.filter((symbol) =>
    symbol.kind === "test" || /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\./iu.test(symbol.file ?? "")
  );
  const changed = atlas.git_changes.flatMap((change) =>
    [...change.symbol_ids, ...change.impacted_symbol_ids, ...change.related_test_ids]
      .flatMap((id) => byId.get(id) ?? [])
  );
  const domainMembers = atlas.domains.slice(0, 3).flatMap((domain) =>
    domain.member_ids.slice(0, 2).flatMap((id) => byId.get(id) ?? [])
  );
  return [
    tour(atlas, "start-here", "Start here", "Find the principal interfaces, components, and storage boundary.",
      [...entrypoints, ...interfaces, ...storage], 4),
    tour(atlas, "request-flow", "How a request flows", "Follow the strongest detected execution journey and inspect uncertainty at each hop.",
      flowSymbols.length > 0 ? flowSymbols : [...entrypoints, ...interfaces], 3),
    tour(atlas, "data-storage", "How data is stored", "Move from a public boundary toward query, persistence, model, or datastore code.",
      [...entrypoints.slice(0, 1), ...storage], 3),
    tour(atlas, "add-feature", "How to add a feature", "Identify an entrypoint, owning domain, implementation component, and nearby validation surface.",
      [...entrypoints.slice(0, 1), ...domainMembers, ...tests.slice(0, 2)], 4),
    tour(atlas, "test-change", "How to test a change", "Connect current or representative change targets to affected tests and validation code.",
      changed.length > 0 ? changed : [...interfaces.slice(0, 2), ...tests], 3),
  ];
}
