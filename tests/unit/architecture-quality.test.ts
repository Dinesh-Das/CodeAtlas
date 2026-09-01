import { describe, expect, it } from "vitest";
import {
  classifyArchitecturalScope,
  isArchitecturalEntrypoint,
} from "../../src/analysis/scope.js";
import { buildExecutionFlows } from "../../src/analysis/flows.js";
import { analyzeImpact, analyzePotentialImpact } from "../../src/analysis/impact.js";
import type { Atlas, AtlasRelationship, AtlasSymbol } from "../../src/ir/models.js";

function symbol(id: string, overrides: Partial<AtlasSymbol> = {}): AtlasSymbol {
  return {
    id,
    kind: "function",
    name: id,
    qualified_name: id,
    file: "src/app.ts",
    scope: "production",
    language: "typescript",
    location: null,
    domain_ids: [],
    visibility: "public",
    signature: null,
    content_hash: null,
    confidence: 1,
    provenance: "AST",
    fact_class: "EXTRACTED",
    evidence_ids: [],
    metadata: {},
    ...overrides,
  };
}

function relationship(
  id: string,
  source: string,
  target: string,
  overrides: Partial<AtlasRelationship> = {},
): AtlasRelationship {
  return {
    id,
    source,
    target,
    type: "CALLS",
    confidence: 1,
    provenance: "AST",
    fact_class: "RESOLVED",
    evidence_ids: [],
    metadata: {},
    ...overrides,
  };
}

function atlas(symbols: AtlasSymbol[], relationships: AtlasRelationship[]): Atlas {
  return {
    schema_version: "1.0",
    generator: { name: "CodeAtlas", version: "test", indexer_version: "test" },
    project: { id: "repo:test", name: "test", root: ".", git_commit: null, git_branch: null, dirty: false },
    snapshot: { id: "test", created_at: "1970-01-01T00:00:00.000Z" },
    symbols,
    relationships,
    evidence: [],
    domains: [],
    entrypoint_ids: [symbols[0]!.id],
    flows: [],
    control_flows: [],
    impact: { forward: {}, reverse: {}, scores: [] },
    git_changes: [],
    rules: [],
    rule_violations: [],
    review_findings: [],
    statistics: { files: 0, symbols: symbols.length, relationships: relationships.length, domains: 0, entrypoints: 1, flows: 0, control_flows: 0, rule_violations: 0, review_findings: 0 },
  };
}

describe("architecture quality gates", () => {
  it("classifies fixtures separately and promotes real CLI/MCP entrypoints", () => {
    expect(classifyArchitecturalScope("tests/fixtures/framework/routes.ts")).toBe("fixture");
    expect(classifyArchitecturalScope("scripts/benchmark.mjs")).toBe("tooling");
    expect(classifyArchitecturalScope("benchmark.js")).toBe("tooling");
    expect(classifyArchitecturalScope("test.js")).toBe("test");
    expect(classifyArchitecturalScope("index.test-d.ts")).toBe("test");
    expect(classifyArchitecturalScope("LICENSE")).toBe("documentation");
    expect(classifyArchitecturalScope(".gitignore")).toBe("configuration");
    expect(classifyArchitecturalScope("src/service.ts")).toBe("production");
    expect(isArchitecturalEntrypoint(symbol("createProgram", {
      name: "createProgram",
      file: "src/cli/index.ts",
    }))).toBe(true);
    expect(isArchitecturalEntrypoint(symbol("fixture", {
      kind: "endpoint",
      file: "tests/fixtures/routes.ts",
      scope: "fixture",
    }))).toBe(false);
  });

  it("preserves diamond branches without reporting a false cycle", () => {
    const input = atlas(
      [symbol("A"), symbol("B"), symbol("C"), symbol("D")],
      [
        relationship("ab", "A", "B"),
        relationship("ac", "A", "C"),
        relationship("bd", "B", "D"),
        relationship("cd", "C", "D"),
      ],
    );
    const [flow] = buildExecutionFlows(input, { maxPaths: 10 });
    expect(flow?.cycle_detected).toBe(false);
    expect(flow?.edges).toHaveLength(4);
    expect(flow?.paths?.map((path) => path.symbol_ids)).toEqual([
      ["A", "B", "D"],
      ["A", "C", "D"],
    ]);
  });

  it("keeps low-confidence heuristics out of definite impact", () => {
    const input = atlas(
      [symbol("changed"), symbol("verified"), symbol("guess")],
      [
        relationship("verified-edge", "verified", "changed"),
        relationship("guess-edge", "guess", "changed", {
          type: "REFERENCES",
          confidence: 0.2,
          provenance: "HEURISTIC",
          fact_class: "INFERRED",
        }),
      ],
    );
    expect(analyzeImpact(input, "changed").map((path) => path.impacted)).toEqual(["verified"]);
    expect(analyzePotentialImpact(input, "changed").map((path) => path.impacted)).toEqual(["guess"]);
  });

  it("preserves distinct impact branches and includes mixed potential paths", () => {
    const input = atlas(
      [symbol("changed"), symbol("left"), symbol("right"), symbol("shared"), symbol("possible")],
      [
        relationship("left-change", "left", "changed"),
        relationship("right-change", "right", "changed"),
        relationship("shared-left", "shared", "left"),
        relationship("shared-right", "shared", "right"),
        relationship("possible-shared", "possible", "shared", {
          confidence: 0.7,
          provenance: "HEURISTIC",
          fact_class: "INFERRED",
        }),
      ],
    );
    expect(analyzeImpact(input, "changed").filter((path) => path.impacted === "shared"))
      .toHaveLength(2);
    expect(analyzePotentialImpact(input, "changed")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          impacted: "possible",
          classification: "potential",
          path: expect.arrayContaining(["changed", "possible"]),
        }),
      ]),
    );
  });
});
