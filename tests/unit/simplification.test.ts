import { describe, expect, it } from "vitest";
import { buildDefaultProjection } from "../../src/analysis/simplification.js";
import { ATLAS_SCHEMA_VERSION, type Atlas } from "../../src/ir/models.js";

describe("large graph simplification", () => {
  it("keeps thousands of symbols searchable while bounding the visible projection", () => {
    const symbols: Atlas["symbols"] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `symbol:${index}`,
      kind: "function",
      name: `function${index}`,
      qualified_name: `domain${index % 20}.function${index}`,
      file: `src/domain${index % 20}/file${index}.ts`,
      language: "typescript",
      location: { start_line: 1, start_column: 0, end_line: 1, end_column: 1 },
      domain_ids: [`domain:${index % 20}`],
      visibility: "public",
      signature: null,
      content_hash: null,
      confidence: 1,
      provenance: "AST",
      fact_class: "EXTRACTED",
      evidence_ids: [],
      metadata: {},
    }));
    const domains: Atlas["domains"] = Array.from({ length: 20 }, (_, index) => ({
      id: `domain:${index}`,
      name: `Domain ${index}`,
      member_ids: symbols.filter((symbol) => symbol.domain_ids[0] === `domain:${index}`).map((symbol) => symbol.id),
      file_ids: [], entrypoint_ids: [], internal_relationship_ids: [], outgoing_relationship_ids: [],
      confidence: 1, label_provenance: "STATIC_ANALYSIS", evidence_ids: [],
    }));
    symbols.push(...domains.map((domain) => ({
      id: domain.id, kind: "domain", name: domain.name, qualified_name: domain.name, file: null,
      language: null, location: null, domain_ids: [], visibility: null, signature: null,
      content_hash: null, confidence: 1, provenance: "STATIC_ANALYSIS" as const,
      fact_class: "INFERRED" as const, evidence_ids: [], metadata: {},
    })));
    const atlas: Atlas = {
      schema_version: ATLAS_SCHEMA_VERSION,
      generator: { name: "CodeAtlas", version: "test", indexer_version: "test" },
      project: { id: "repo:test", name: "large", root: ".", git_commit: null, git_branch: null, dirty: false },
      snapshot: { id: "large", created_at: "2026-01-01T00:00:00.000Z" },
      symbols, relationships: [], evidence: [], domains, entrypoint_ids: [], flows: [], control_flows: [],
      impact: { forward: {}, reverse: {}, scores: [] }, git_changes: [], rules: [], rule_violations: [], review_findings: [],
      statistics: { files: 5_000, symbols: symbols.length, relationships: 0, domains: 20, entrypoints: 0,
        flows: 0, control_flows: 0, rule_violations: 0, review_findings: 0 },
    };
    const projection = buildDefaultProjection(atlas, 150);
    expect(projection.nodes).toHaveLength(20);
    expect(projection.hidden_node_count).toBeGreaterThan(4_900);
    expect(atlas.symbols.some((symbol) => symbol.name === "function4999")).toBe(true);
  });
});
