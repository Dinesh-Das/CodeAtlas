import { describe, expect, it } from "vitest";
import { compareArchitecture } from "../../src/git/architecture-diff.js";
import {
  ATLAS_SCHEMA_VERSION,
  type Atlas,
  type AtlasRelationship,
  type AtlasSymbol,
} from "../../src/ir/models.js";

function symbol(id: string, file = "src/app.ts", name = id): AtlasSymbol {
  return {
    id,
    kind: "endpoint",
    name,
    qualified_name: name,
    file,
    language: "typescript",
    location: { start_line: 1, start_column: 0, end_line: 1, end_column: 1 },
    domain_ids: [],
    visibility: "public",
    signature: null,
    content_hash: null,
    confidence: 1,
    provenance: "AST",
    fact_class: "EXTRACTED",
    evidence_ids: [],
    metadata: {},
  };
}

function atlas(snapshotId: string, entrypointIds: string[]): Atlas {
  const symbols = entrypointIds.map(symbol);
  return {
    schema_version: ATLAS_SCHEMA_VERSION,
    generator: { name: "CodeAtlas", version: "test", indexer_version: "test" },
    project: {
      id: "repo:test",
      name: "test",
      root: ".",
      git_commit: snapshotId,
      git_branch: "main",
      dirty: false,
    },
    snapshot: { id: snapshotId, created_at: "2026-01-01T00:00:00.000Z" },
    symbols,
    relationships: [],
    evidence: [],
    domains: [],
    entrypoint_ids: entrypointIds,
    flows: [],
    control_flows: [],
    impact: { forward: {}, reverse: {}, scores: [] },
    git_changes: [],
    rules: [],
    rule_violations: [],
    review_findings: [],
    statistics: {
      files: 1,
      symbols: symbols.length,
      relationships: 0,
      domains: 0,
      entrypoints: entrypointIds.length,
      flows: 0,
      control_flows: 0,
      rule_violations: 0,
      review_findings: 0,
    },
  };
}

function relationship(id: string, source: string, target: string, type = "CALLS"): AtlasRelationship {
  return {
    id,
    source,
    target,
    type,
    confidence: 1,
    provenance: "AST",
    fact_class: "EXTRACTED",
    evidence_ids: [],
    metadata: {},
  };
}

describe("architecture snapshot diff", () => {
  it("reports entrypoint additions and removals in the correct direction", () => {
    const result = compareArchitecture(
      atlas("old", ["endpoint:removed", "endpoint:retained"]),
      atlas("new", ["endpoint:retained", "endpoint:added"]),
    );

    expect(result.entrypoints).toEqual({
      added: ["endpoint:added"],
      removed: ["endpoint:removed"],
    });
  });

  it("pairs moved symbols when path-based IDs change", () => {
    const oldAtlas = atlas("old", []);
    const newAtlas = atlas("new", []);
    oldAtlas.symbols = [symbol("endpoint:old-path", "src/auth/controller.ts", "login")];
    newAtlas.symbols = [symbol("endpoint:new-path", "src/api/auth-controller.ts", "login")];

    const result = compareArchitecture(oldAtlas, newAtlas);

    expect(result.symbols.added).toEqual([]);
    expect(result.symbols.removed).toEqual([]);
    expect(result.symbols.moved).toEqual(["endpoint:new-path"]);
    expect(result.symbols.moved_pairs).toEqual([
      { previous_id: "endpoint:old-path", current_id: "endpoint:new-path" },
    ]);
  });

  it("reports deterministic architecture evolution signals", () => {
    const oldAtlas = atlas("old", ["endpoint:old-api"]);
    const newAtlas = atlas("new", ["endpoint:new-api"]);
    const a = symbol("function:a", "src/a.ts", "a");
    a.kind = "function";
    const b = symbol("function:b", "src/b.ts", "b");
    b.kind = "function";
    oldAtlas.symbols.push(a, b);
    newAtlas.symbols.push(a, b);
    oldAtlas.relationships = [relationship("edge:a-b", a.id, b.id)];
    newAtlas.relationships = [
      relationship("edge:a-b", a.id, b.id),
      relationship("edge:b-a", b.id, a.id),
    ];
    oldAtlas.impact.scores = [{
      symbol_id: a.id, score: 1, risk: "low", direct_callers: 0, transitive_reach: 0,
      affected_entrypoints: 0, affected_domains: 0, cross_domain: false, affected_apis: 0,
      affected_tests: 0, affected_rules: 0, database_schema_impact: false, centrality: 1,
      components: {
        direct_callers: { value: 0, weight: 0, contribution: 0 },
        transitive_reach: { value: 0, weight: 0, contribution: 0 },
        affected_entrypoints: { value: 0, weight: 0, contribution: 0 },
        cross_domain: { value: 0, weight: 0, contribution: 0 },
        public_api: { value: 0, weight: 0, contribution: 0 },
        database_schema: { value: 0, weight: 0, contribution: 0 },
        missing_test_coverage: { value: 0, weight: 0, contribution: 0 },
        centrality: { value: 1, weight: 1, contribution: 1 },
        architecture_rules: { value: 0, weight: 0, contribution: 0 },
      },
      reasons: [],
    }];
    newAtlas.impact.scores = [{ ...oldAtlas.impact.scores[0]!, centrality: 2 }];
    oldAtlas.rule_violations = [{
      id: "violation:resolved", rule_id: "rule:test", severity: "warning", source_id: a.id,
      target_id: b.id, path: [a.id, b.id], relationship_ids: ["edge:a-b"], evidence_ids: [], message: "old",
    }];
    newAtlas.rule_violations = [{
      id: "violation:introduced", rule_id: "rule:test", severity: "warning", source_id: b.id,
      target_id: a.id, path: [b.id, a.id], relationship_ids: ["edge:b-a"], evidence_ids: [], message: "new",
    }];

    const result = compareArchitecture(oldAtlas, newAtlas);

    expect(result.apis).toEqual({ added: ["endpoint:new-api"], removed: ["endpoint:old-api"] });
    expect(result.dependencies.added).toEqual(["edge:b-a"]);
    expect(result.cycles.added).toEqual([["function:a", "function:b"]]);
    expect(result.cycles.resolved).toEqual([]);
    expect(result.centrality.changed).toEqual([
      { symbol_id: "function:a", previous: 1, current: 2, delta: 1 },
    ]);
    expect(result.rule_violations).toEqual({
      introduced: ["violation:introduced"],
      resolved: ["violation:resolved"],
    });
  });
});
