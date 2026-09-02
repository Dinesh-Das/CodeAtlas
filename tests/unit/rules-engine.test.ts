import { describe, expect, it } from "vitest";
import { ATLAS_SCHEMA_VERSION, type ArchitectureRule, type Atlas } from "../../src/ir/models.js";
import { evaluateArchitectureRules } from "../../src/rules/engine.js";

function symbol(
  id: string,
  file: string,
  domain: string,
  kind = "function",
): Atlas["symbols"][number] {
  return {
    id,
    kind,
    name: id,
    qualified_name: id,
    file,
    language: "typescript",
    location: { start_line: 1, start_column: 0, end_line: 1, end_column: 1 },
    domain_ids: [domain],
    visibility: "public",
    signature: null,
    content_hash: null,
    confidence: 1,
    provenance: "AST",
    fact_class: "EXTRACTED",
    evidence_ids: [`evidence:${id}`],
    metadata: {},
  };
}

function relationship(
  id: string,
  source: string,
  target: string,
  type: string,
): Atlas["relationships"][number] {
  return {
    id,
    source,
    target,
    type,
    confidence: 1,
    provenance: "AST",
    fact_class: "RESOLVED",
    evidence_ids: [`evidence:${id}`],
    metadata: {},
  };
}

function atlas(): Atlas {
  const symbols = [
    symbol("controller", "src/auth/controller.ts", "domain:auth"),
    symbol("service", "src/auth/service.ts", "domain:auth"),
    symbol("gateway", "src/shared/gateway.ts", "domain:shared"),
    symbol("repository", "src/data/repository.ts", "domain:data", "class"),
    symbol("payments", "src/payments/service.ts", "domain:payments"),
  ];
  const relationships = [
    relationship("call:controller-service", "controller", "service", "CALLS"),
    relationship("import:controller-repository", "controller", "repository", "IMPORTS"),
    relationship("call:service-repository", "service", "repository", "CALLS"),
    relationship("call:controller-gateway", "controller", "gateway", "CALLS"),
    relationship("call:gateway-repository", "gateway", "repository", "CALLS"),
    relationship("call:controller-payments", "controller", "payments", "CALLS"),
    relationship("contains:controller-repository", "controller", "repository", "CONTAINS"),
  ];
  return {
    schema_version: ATLAS_SCHEMA_VERSION,
    generator: { name: "CodeAtlas", version: "test", indexer_version: "test" },
    project: { id: "repo:test", name: "test", root: ".", git_commit: null, git_branch: null, dirty: false },
    snapshot: { id: "test", created_at: "2026-01-01T00:00:00.000Z" },
    symbols,
    relationships,
    evidence: [],
    domains: [
      { id: "domain:auth", name: "auth", member_ids: [], file_ids: [], entrypoint_ids: [], internal_relationship_ids: [], outgoing_relationship_ids: [], confidence: 1, label_provenance: "STATIC_ANALYSIS", evidence_ids: [] },
      { id: "domain:shared", name: "shared", member_ids: [], file_ids: [], entrypoint_ids: [], internal_relationship_ids: [], outgoing_relationship_ids: [], confidence: 1, label_provenance: "STATIC_ANALYSIS", evidence_ids: [] },
      { id: "domain:data", name: "data", member_ids: [], file_ids: [], entrypoint_ids: [], internal_relationship_ids: [], outgoing_relationship_ids: [], confidence: 1, label_provenance: "STATIC_ANALYSIS", evidence_ids: [] },
      { id: "domain:payments", name: "payments", member_ids: [], file_ids: [], entrypoint_ids: [], internal_relationship_ids: [], outgoing_relationship_ids: [], confidence: 1, label_provenance: "STATIC_ANALYSIS", evidence_ids: [] },
    ],
    entrypoint_ids: [], flows: [], control_flows: [],
    impact: { forward: {}, reverse: {}, scores: [] },
    git_changes: [], rules: [], rule_violations: [], review_findings: [],
    statistics: { files: 5, symbols: symbols.length, relationships: relationships.length, domains: 4, entrypoints: 0, flows: 0, control_flows: 0, rule_violations: 0, review_findings: 0 },
  };
}

function rule(id: string, source: Record<string, string>, forbid: Record<string, unknown>): ArchitectureRule {
  return { id, description: id, severity: "error", source, forbid };
}

describe("architecture rules engine", () => {
  it("treats calls and imports as direct dependencies while excluding structural edges", () => {
    const input = atlas();
    input.relationships.push({
      ...relationship("heuristic:controller-payments", "controller", "payments", "CALLS"),
      confidence: 0.35,
      provenance: "HEURISTIC",
      fact_class: "INFERRED",
    });
    const result = evaluateArchitectureRules(input, [
      rule("dependency", { matches_path: "src/auth/controller" }, { depends_on: { layer: "repository" } }),
      rule("calls", { layer: "controller" }, { calls: { layer: "service" } }),
      rule("imports", { layer: "controller" }, { imports: { kind: "class", domain: "data" } }),
    ]);

    expect(result.filter((item) => item.rule_id === "dependency")).toHaveLength(1);
    expect(result.find((item) => item.rule_id === "dependency")?.relationship_ids).toEqual(["import:controller-repository"]);
    expect(result.some((item) => item.rule_id === "calls" &&
      item.relationship_ids[0] === "call:controller-service")).toBe(true);
    expect(result.find((item) => item.rule_id === "imports")?.relationship_ids).toEqual(["import:controller-repository"]);
    expect(result.flatMap((item) => item.relationship_ids)).not.toContain("heuristic:controller-payments");
  });

  it("supports bounded paths, unless_via, domain crossing, membership, path matching, selectors, and evidence", () => {
    const input = atlas();
    input.relationships.push(
      relationship("call:service-gateway", "service", "gateway", "CALLS"),
      relationship("call:repository-service", "repository", "service", "CALLS"),
    );
    const result = evaluateArchitectureRules(input, [
      rule("path", { layer: "controller" }, { path_to: { kind: "class", domain: "data" } }),
      rule("path-unless", { layer: "controller" }, { path_to: { kind: "class", domain: "data" }, unless_via: { matches_path: "src/shared" } }),
      rule("cross-domain", { layer: "controller" }, { crosses_domain: true }),
      rule("belongs", { kind: "class" }, { belongs_to: { domain: "data" } }),
      rule("path-match", { kind: "function" }, { matches_path: "payments" }),
    ]);

    const pathViolation = result.find((item) => item.rule_id === "path");
    expect(pathViolation?.path).toEqual(["controller", "repository"]);
    expect(pathViolation?.evidence_ids).toEqual(expect.arrayContaining([
      "evidence:controller",
      "evidence:repository",
      "evidence:import:controller-repository",
    ]));
    expect(result.find((item) => item.rule_id === "path-unless")?.path).toEqual(["controller", "repository"]);
    expect(result.some((item) => item.rule_id === "cross-domain" && item.target_id === "payments")).toBe(true);
    expect(result.find((item) => item.rule_id === "belongs")?.source_id).toBe("repository");
    expect(result.find((item) => item.rule_id === "path-match")?.source_id).toBe("payments");
  });
});
