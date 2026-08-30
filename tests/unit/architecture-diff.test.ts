import { describe, expect, it } from "vitest";
import { compareArchitecture } from "../../src/git/architecture-diff.js";
import { ATLAS_SCHEMA_VERSION, type Atlas, type AtlasSymbol } from "../../src/ir/models.js";

function symbol(id: string): AtlasSymbol {
  return {
    id,
    kind: "endpoint",
    name: id,
    qualified_name: id,
    file: "src/app.ts",
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
});
