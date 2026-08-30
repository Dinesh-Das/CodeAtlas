import { describe, expect, it } from "vitest";
import { createEvidenceId } from "../../src/ir/evidence.js";
import { ATLAS_SCHEMA_VERSION, type Atlas } from "../../src/ir/models.js";
import { semanticAtlasJson } from "../../src/ir/serialization.js";
import { validateAtlas } from "../../src/ir/validation.js";

function fixture(): Atlas {
  const evidenceId = createEvidenceId({
    file: "src/a.ts", startLine: 1, startColumn: 0, endLine: 1, endColumn: 10, symbolId: "function:a",
  });
  return {
    schema_version: ATLAS_SCHEMA_VERSION,
    generator: { name: "CodeAtlas", version: "test", indexer_version: "test" },
    project: { id: "repo:test", name: "test", root: ".", git_commit: null, git_branch: null, dirty: true },
    snapshot: { id: "worktree-test", created_at: "2026-01-01T00:00:00.000Z" },
    symbols: [{
      id: "function:a", kind: "function", name: "a", qualified_name: "a", file: "src/a.ts",
      language: "typescript", location: { start_line: 1, start_column: 0, end_line: 1, end_column: 10 },
      domain_ids: [], visibility: "public", signature: "function a()", content_hash: null, confidence: 1,
      provenance: "AST", fact_class: "EXTRACTED", evidence_ids: [evidenceId], metadata: {},
    }],
    relationships: [],
    evidence: [{
      id: evidenceId, file: "src/a.ts", start_line: 1, start_column: 0, end_line: 1,
      end_column: 10, symbol_id: "function:a", relationship_id: null, kind: "source",
      excerpt: "function a() {}", content_hash: null,
    }],
    domains: [], entrypoint_ids: [], flows: [], control_flows: [],
    impact: { forward: {}, reverse: {}, scores: [] }, git_changes: [], rules: [],
    rule_violations: [], review_findings: [],
    statistics: { files: 1, symbols: 1, relationships: 0, domains: 0, entrypoints: 0,
      flows: 0, control_flows: 0, rule_violations: 0, review_findings: 0 },
  };
}

describe("canonical CodeAtlas IR", () => {
  it("creates deterministic evidence IDs and validates references", () => {
    expect(createEvidenceId({ file: "src/a.ts", startLine: 1, startColumn: 0, endLine: 1, endColumn: 10, symbolId: "function:a" }))
      .toBe(fixture().evidence[0]!.id);
    expect(validateAtlas(fixture())).toEqual({ valid: true, errors: [] });
  });

  it("rejects missing evidence and ignores generated time in semantic comparison", () => {
    const atlas = fixture();
    atlas.symbols[0]!.evidence_ids = ["evidence:missing"];
    expect(validateAtlas(atlas).errors).toContain("Symbol function:a has missing evidence evidence:missing");
    const first = fixture();
    const second = fixture();
    second.snapshot.created_at = "2030-01-01T00:00:00.000Z";
    expect(semanticAtlasJson(first)).toBe(semanticAtlasJson(second));
  });
});
