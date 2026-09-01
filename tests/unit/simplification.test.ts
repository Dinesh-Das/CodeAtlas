import { describe, expect, it } from "vitest";
import {
  buildDefaultProjection,
  detectHighDegreeHubs,
  symbolSearchText,
} from "../../src/analysis/simplification.js";
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
    symbols.push({
      ...symbols[0]!,
      id: "symbol:test-only",
      name: "testOnly",
      qualified_name: "tests.testOnly",
      file: "tests/fixtures/test-only.ts",
      scope: "fixture",
      domain_ids: ["domain:tests"],
    });
    domains.push({
      id: "domain:tests", name: "Tests", member_ids: ["symbol:test-only"], file_ids: [],
      entrypoint_ids: [], internal_relationship_ids: [], outgoing_relationship_ids: [], confidence: 1,
      label_provenance: "STATIC_ANALYSIS", evidence_ids: [],
    });
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

  it("aggregates dependency edges deterministically and preserves representative relationships", () => {
    const symbols: Atlas["symbols"] = [
      {
        id: "symbol:auth", kind: "function", name: "authenticate", qualified_name: "auth.authenticate",
        file: "src/auth/service.ts", language: "typescript",
        location: { start_line: 1, start_column: 0, end_line: 3, end_column: 1 },
        domain_ids: ["domain:auth"], visibility: "public", signature: null, content_hash: null,
        confidence: 1, provenance: "AST", fact_class: "EXTRACTED", evidence_ids: [], metadata: {},
      },
      {
        id: "symbol:user", kind: "function", name: "loadUser", qualified_name: "users.loadUser",
        file: "src/users/repository.ts", language: "typescript",
        location: { start_line: 1, start_column: 0, end_line: 3, end_column: 1 },
        domain_ids: ["domain:users"], visibility: "public", signature: null, content_hash: null,
        confidence: 1, provenance: "AST", fact_class: "EXTRACTED", evidence_ids: [], metadata: {},
      },
    ];
    const atlas: Atlas = {
      schema_version: ATLAS_SCHEMA_VERSION,
      generator: { name: "CodeAtlas", version: "test", indexer_version: "test" },
      project: { id: "repo:test", name: "aggregate", root: ".", git_commit: null, git_branch: null, dirty: false },
      snapshot: { id: "aggregate", created_at: "2026-01-01T00:00:00.000Z" },
      symbols,
      relationships: [
        { id: "rel:call", source: "symbol:auth", target: "symbol:user", type: "CALLS", confidence: 0.7, provenance: "STATIC_ANALYSIS", fact_class: "RESOLVED", evidence_ids: [], metadata: {} },
        { id: "rel:import", source: "symbol:auth", target: "symbol:user", type: "IMPORTS", confidence: 0.95, provenance: "STATIC_ANALYSIS", fact_class: "RESOLVED", evidence_ids: [], metadata: {} },
        { id: "rel:contains", source: "symbol:auth", target: "symbol:user", type: "CONTAINS", confidence: 1, provenance: "AST", fact_class: "EXTRACTED", evidence_ids: [], metadata: {} },
      ],
      evidence: [],
      domains: [
        { id: "domain:auth", name: "Authentication", member_ids: ["symbol:auth"], file_ids: [], entrypoint_ids: [], internal_relationship_ids: [], outgoing_relationship_ids: ["rel:call", "rel:import"], confidence: 1, label_provenance: "STATIC_ANALYSIS", evidence_ids: [] },
        { id: "domain:users", name: "Users", member_ids: ["symbol:user"], file_ids: [], entrypoint_ids: [], internal_relationship_ids: [], outgoing_relationship_ids: [], confidence: 1, label_provenance: "STATIC_ANALYSIS", evidence_ids: [] },
      ],
      entrypoint_ids: [], flows: [], control_flows: [],
      impact: { forward: {}, reverse: {}, scores: [] }, git_changes: [], rules: [], rule_violations: [], review_findings: [],
      statistics: { files: 2, symbols: 2, relationships: 3, domains: 2, entrypoints: 0, flows: 0, control_flows: 0, rule_violations: 0, review_findings: 0 },
    };

    const projection = buildDefaultProjection(atlas, 1);
    expect(projection.nodes.map((node) => node.id)).toEqual(["domain:auth"]);
    expect(projection.truncated).toBe(true);
    expect(projection.warnings).toHaveLength(1);

    const fullProjection = buildDefaultProjection(atlas, 2);
    expect(fullProjection.edges).toEqual([
      expect.objectContaining({
        source: "domain:auth",
        target: "domain:users",
        count: 2,
        relationship_ids: ["rel:call", "rel:import"],
        representative_relationship_ids: ["rel:import", "rel:call"],
      }),
    ]);
  });

  it("detects hubs without mutating the IR and searches hidden endpoint evidence and domain names", () => {
    const endpoint: Atlas["symbols"][number] = {
      id: "symbol:endpoint", kind: "endpoint", name: "POST login", qualified_name: "auth.POST.login",
      file: "src/auth/routes.ts", language: "typescript",
      location: { start_line: 4, start_column: 0, end_line: 4, end_column: 30 },
      domain_ids: ["domain:auth"], visibility: "public", signature: "POST <literal>", content_hash: null,
      confidence: 1, provenance: "STATIC_ANALYSIS", fact_class: "RESOLVED", evidence_ids: ["evidence:route"],
      metadata: { http_method: "POST", framework: "express" },
    };
    const helper: Atlas["symbols"][number] = {
      ...endpoint, id: "symbol:helper", kind: "function", name: "logger", qualified_name: "shared.logger",
      file: "src/shared/logger.ts", domain_ids: ["domain:shared"], evidence_ids: [], metadata: {},
    };
    const leaf: Atlas["symbols"][number] = {
      ...endpoint, id: "symbol:leaf", kind: "function", name: "leaf", qualified_name: "auth.leaf",
      file: "src/auth/leaf.ts", evidence_ids: [], metadata: {},
    };
    const atlas: Atlas = {
      schema_version: ATLAS_SCHEMA_VERSION,
      generator: { name: "CodeAtlas", version: "test", indexer_version: "test" },
      project: { id: "repo:test", name: "search", root: ".", git_commit: null, git_branch: null, dirty: false },
      snapshot: { id: "search", created_at: "2026-01-01T00:00:00.000Z" },
      symbols: [endpoint, helper, leaf],
      relationships: [
        { id: "rel:1", source: endpoint.id, target: helper.id, type: "CALLS", confidence: 1, provenance: "STATIC_ANALYSIS", fact_class: "RESOLVED", evidence_ids: [], metadata: {} },
        { id: "rel:2", source: leaf.id, target: helper.id, type: "CALLS", confidence: 1, provenance: "STATIC_ANALYSIS", fact_class: "RESOLVED", evidence_ids: [], metadata: {} },
      ],
      evidence: [{ id: "evidence:route", file: "src/auth/routes.ts", start_line: 4, start_column: 0, end_line: 4, end_column: 30, symbol_id: endpoint.id, relationship_id: null, kind: "source", excerpt: 'app.post("/login", login);', content_hash: null }],
      domains: [
        { id: "domain:auth", name: "Authentication", member_ids: [endpoint.id, leaf.id], file_ids: [], entrypoint_ids: [endpoint.id], internal_relationship_ids: [], outgoing_relationship_ids: ["rel:1"], confidence: 1, label_provenance: "STATIC_ANALYSIS", evidence_ids: [] },
        { id: "domain:shared", name: "Shared Utilities", member_ids: [helper.id], file_ids: [], entrypoint_ids: [], internal_relationship_ids: [], outgoing_relationship_ids: [], confidence: 1, label_provenance: "STATIC_ANALYSIS", evidence_ids: [] },
      ],
      entrypoint_ids: [endpoint.id], flows: [], control_flows: [],
      impact: { forward: {}, reverse: {}, scores: [] }, git_changes: [], rules: [], rule_violations: [], review_findings: [],
      statistics: { files: 3, symbols: 3, relationships: 2, domains: 2, entrypoints: 1, flows: 0, control_flows: 0, rule_violations: 0, review_findings: 0 },
    };
    const symbolCount = atlas.symbols.length;
    const relationshipCount = atlas.relationships.length;

    expect(detectHighDegreeHubs(atlas, { minimumDegree: 2 })).toEqual([
      { symbol_id: helper.id, degree: 2, incoming: 2, outgoing: 0 },
    ]);
    expect(atlas.symbols).toHaveLength(symbolCount);
    expect(atlas.relationships).toHaveLength(relationshipCount);
    expect(symbolSearchText(endpoint, atlas)).toContain("authentication");
    expect(symbolSearchText(endpoint, atlas)).toContain("/login");
  });
});
