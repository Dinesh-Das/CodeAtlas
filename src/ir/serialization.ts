import type { Atlas } from "./models.js";

function sortedRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function normalizeAtlas(atlas: Atlas): Atlas {
  const byId = <T extends { id: string }>(left: T, right: T): number =>
    left.id.localeCompare(right.id);
  const strings = (values: readonly string[]): string[] =>
    [...new Set(values)].sort((left, right) => left.localeCompare(right));

  return {
    ...atlas,
    symbols: atlas.symbols.map((symbol) => ({
      ...symbol,
      domain_ids: strings(symbol.domain_ids),
      evidence_ids: strings(symbol.evidence_ids),
      metadata: sortedRecord(symbol.metadata),
    })).sort(byId),
    relationships: atlas.relationships.map((relationship) => ({
      ...relationship,
      evidence_ids: strings(relationship.evidence_ids),
      metadata: sortedRecord(relationship.metadata),
    })).sort(byId),
    evidence: [...atlas.evidence].sort(byId),
    domains: atlas.domains.map((domain) => ({
      ...domain,
      member_ids: strings(domain.member_ids),
      file_ids: strings(domain.file_ids),
      entrypoint_ids: strings(domain.entrypoint_ids),
      internal_relationship_ids: strings(domain.internal_relationship_ids),
      outgoing_relationship_ids: strings(domain.outgoing_relationship_ids),
      evidence_ids: strings(domain.evidence_ids),
    })).sort(byId),
    entrypoint_ids: strings(atlas.entrypoint_ids),
    flows: atlas.flows.map((flow) => ({
      ...flow,
      steps: [...flow.steps].sort((left, right) => left.order - right.order),
    })).sort(byId),
    control_flows: atlas.control_flows.map((flow) => ({
      ...flow,
      nodes: [...flow.nodes].sort(byId),
      edges: [...flow.edges].sort(byId),
    })).sort(byId),
    impact: {
      forward: sortedRecord(Object.fromEntries(
        Object.entries(atlas.impact.forward).map(([id, values]) => [id, strings(values)]),
      )),
      reverse: sortedRecord(Object.fromEntries(
        Object.entries(atlas.impact.reverse).map(([id, values]) => [id, strings(values)]),
      )),
      scores: [...atlas.impact.scores].sort((left, right) => left.symbol_id.localeCompare(right.symbol_id)),
    },
    git_changes: [...atlas.git_changes].sort(byId),
    rules: [...atlas.rules].sort(byId),
    rule_violations: [...atlas.rule_violations].sort(byId),
    review_findings: [...atlas.review_findings].sort(byId),
  };
}

export function serializeAtlas(atlas: Atlas): string {
  return `${JSON.stringify(normalizeAtlas(atlas), null, 2)}\n`;
}

export function semanticAtlasJson(atlas: Atlas): string {
  const normalized = normalizeAtlas(atlas);
  return JSON.stringify({
    ...normalized,
    snapshot: { ...normalized.snapshot, created_at: "" },
  });
}
