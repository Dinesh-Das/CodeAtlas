import { describe, expect, it } from "vitest";
import { answerFromAtlas } from "../../src/ai/answering.js";
import { summarizeReviewArchitecture } from "../../src/cli/review.js";
import { renderAtlasHtml } from "../../src/export/html.js";
import { renderAtlasMermaid } from "../../src/export/mermaid.js";
import { createEvidenceId } from "../../src/ir/evidence.js";
import { validateEvidenceIds } from "../../src/ir/evidence-validation.js";
import { ATLAS_SCHEMA_VERSION, type Atlas } from "../../src/ir/models.js";
import { semanticAtlasJson } from "../../src/ir/serialization.js";
import { validateAtlas } from "../../src/ir/validation.js";
import { validateReviewFindings } from "../../src/review/evidence-validation.js";

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

  it("rejects evidence whose snapshot location cannot be grounded", () => {
    const unresolved = fixture();
    unresolved.evidence[0]!.excerpt = null;
    expect(validateEvidenceIds(unresolved, [unresolved.evidence[0]!.id]).rejected[0]?.reason)
      .toContain("could not be resolved");

    const wrongFile = fixture();
    wrongFile.evidence[0]!.file = "src/missing.ts";
    expect(validateEvidenceIds(wrongFile, [wrongFile.evidence[0]!.id]).rejected[0]?.reason)
      .toContain("not present in the indexed snapshot");

    const wrongRange = fixture();
    wrongRange.evidence[0]!.start_line = 20;
    wrongRange.evidence[0]!.end_line = 20;
    expect(validateEvidenceIds(wrongRange, [wrongRange.evidence[0]!.id]).rejected[0]?.reason)
      .toContain("does not overlap its symbol");
  });

  it("returns only grounded answer claims and rejects unsupported review findings", () => {
    const atlas = fixture();
    const answer = answerFromAtlas(atlas, "function implementation");
    expect(answer.provenance).toBe("STATIC_ANALYSIS");
    expect(answer.claims.length).toBeGreaterThan(0);
    expect(answer.evidence.length).toBeGreaterThan(0);
    for (const claim of answer.claims) {
      expect(claim.evidence_ids.length).toBeGreaterThan(0);
      expect(validateEvidenceIds(atlas, claim.evidence_ids).rejected).toEqual([]);
    }

    const unsupportedAtlas = fixture();
    unsupportedAtlas.symbols[0]!.evidence_ids = ["evidence:missing"];
    const unsupportedAnswer = answerFromAtlas(unsupportedAtlas, "function implementation");
    expect(unsupportedAnswer.claims).toEqual([]);
    expect(unsupportedAnswer.evidence).toEqual([]);
    expect(unsupportedAnswer.answer).toContain("does not have enough source evidence");

    const symbol = atlas.symbols[0]!;
    const validFinding = {
      id: "finding:valid",
      severity: "high" as const,
      category: "ai review",
      title: "Grounded finding",
      description: "Supported by repository evidence.",
      changed_symbol_ids: [symbol.id],
      impacted_symbol_ids: [],
      evidence_ids: symbol.evidence_ids,
      impact_paths: [],
      confidence: 0.9,
      provenance: "LLM" as const,
    };
    const unsupportedFinding = {
      ...validFinding,
      id: "finding:unsupported",
      evidence_ids: ["evidence:hallucinated"],
    };
    const validation = validateReviewFindings(atlas, [validFinding, unsupportedFinding]);
    expect(validation.valid).toEqual([validFinding]);
    expect(validation.rejected).toEqual([
      expect.objectContaining({
        finding: unsupportedFinding,
        reason: expect.stringContaining("invalid evidence"),
      }),
    ]);
  });

  it("grounds a generic AI-agent architecture question in repository starting points", () => {
    const atlas = fixture();
    const answer = answerFromAtlas(
      atlas,
      "Explain the repository architecture and where an AI coding agent should start.",
    );
    expect(answer.claims).toHaveLength(1);
    expect(answer.claims[0]).toMatchObject({
      text: "a is a function in src/a.ts.",
      fact_class: "source_fact",
    });
    expect(answer.evidence).toEqual(atlas.evidence);
  });

  it("explains how an AI agent receives source-grounded MCP context", () => {
    const atlas = fixture();
    const names = ["repositoryOverviewIr", "findSymbolIr", "impactIr", "evidenceIr"];
    atlas.symbols = names.map((name, index) => {
      const line = index + 1;
      const id = `function:${name}`;
      const evidenceId = createEvidenceId({
        file: "src/mcp/ir-tools.ts", startLine: line, startColumn: 0,
        endLine: line, endColumn: 20, symbolId: id,
      });
      return {
        ...atlas.symbols[0]!, id, name, qualified_name: name, file: "src/mcp/ir-tools.ts",
        location: { start_line: line, start_column: 0, end_line: line, end_column: 20 },
        signature: `function ${name}()`, evidence_ids: [evidenceId],
      };
    });
    atlas.evidence = atlas.symbols.map((symbol) => ({
      id: symbol.evidence_ids[0]!, file: symbol.file!, start_line: symbol.location!.start_line,
      start_column: 0, end_line: symbol.location!.end_line, end_column: 20,
      symbol_id: symbol.id, relationship_id: null, kind: "source" as const,
      excerpt: `function ${symbol.name}() {}`, content_hash: null,
    }));

    const answer = answerFromAtlas(atlas, "How does an AI agent get MCP project context?");
    expect(answer.answer).toContain("AI agents get indexed repository context through the MCP query layer");
    expect(answer.answer).toContain("source-grounded evidence");
    expect(answer.claims[0]?.fact_class).toBe("semantic_inference");
  });

  it("summarizes architecture-aware review impact and exposes review context in HTML", () => {
    const atlas = fixture();
    const symbol = atlas.symbols[0]!;
    symbol.domain_ids = ["domain:core"];
    atlas.domains = [{
      id: "domain:core", name: "Core", member_ids: [symbol.id], file_ids: [], entrypoint_ids: [symbol.id],
      internal_relationship_ids: [], outgoing_relationship_ids: [], confidence: 1,
      label_provenance: "CONFIG", evidence_ids: symbol.evidence_ids,
    }];
    atlas.entrypoint_ids = [symbol.id];
    atlas.git_changes = [{
      id: "change:a", status: "MODIFIED", file: "src/a.ts", previous_file: null,
      line_ranges: [{ start_line: 1, end_line: 1 }], symbol_ids: [symbol.id], symbol_changes: [],
      impacted_symbol_ids: [], impact_paths: [], source_diff: "+function a() {}", related_test_ids: [],
      rule_violation_ids: ["violation:a"], review_finding_ids: ["finding:a"], evidence_ids: symbol.evidence_ids,
    }];
    atlas.rules = [{
      id: "no-core-call", description: "Core rule", severity: "error", source: {}, forbid: {},
    }];
    atlas.rule_violations = [{
      id: "violation:a", rule_id: "no-core-call", severity: "error", source_id: symbol.id,
      target_id: null, path: [symbol.id], relationship_ids: [], evidence_ids: symbol.evidence_ids,
      message: "Core rule violated",
    }];
    atlas.review_findings = [{
      id: "finding:a", severity: "high", category: "architecture violation", title: "Core rule violated",
      description: "The changed entrypoint violates the configured architecture rule.",
      changed_symbol_ids: [symbol.id], impacted_symbol_ids: [], evidence_ids: symbol.evidence_ids,
      impact_paths: [], confidence: 1, provenance: "STATIC_ANALYSIS",
    }];

    expect(summarizeReviewArchitecture(atlas)).toMatchObject({
      changed_file_count: 1,
      changed_symbol_ids: [symbol.id],
      affected_entrypoint_ids: [symbol.id],
      affected_domain_ids: ["domain:core"],
      rule_violation_count: 1,
      findings_by_severity: { critical: 0, high: 1, medium: 0, low: 0 },
    });
    const html = renderAtlasHtml(atlas);
    expect(html).toContain("What changed");
    expect(html).toContain("Source evidence");
    expect(html).toContain("Architecture rule");
    expect(html).toContain("Related tests");
    expect(html).toContain('id="back-btn"');
    expect(html).toContain("Fit graph");
    expect(html).toContain('aria-label="Zoom graph in"');
    expect(html).toContain('aria-label="Zoom graph out"');
    expect(html).toContain("keyboardActivate");
    expect(html).toContain("goBack");
    expect(html).toContain("Drag to pan");
    expect(html).toContain("ondblclick");
    expect(html).toContain("Direct callers");
    expect(html).toContain("Direct dependencies");
    expect(html).toContain("Evidence");
    expect(html).toContain("Location");
    expect(html).toContain("path.symbol_ids");
    const scriptStart = html.lastIndexOf("<script>") + "<script>".length;
    const scriptEnd = html.lastIndexOf("</script>");
    expect(() => new Function(html.slice(scriptStart, scriptEnd))).not.toThrow();
  });

  it("renders a portable Mermaid architecture diagram", () => {
    const atlas = fixture();
    const symbol = atlas.symbols[0]!;
    symbol.domain_ids = ["domain:core"];
    atlas.domains = [{
      id: "domain:core", name: "Core", member_ids: [symbol.id], file_ids: ["src/a.ts"],
      entrypoint_ids: [symbol.id], internal_relationship_ids: [], outgoing_relationship_ids: [],
      confidence: 1, label_provenance: "CONFIG", evidence_ids: symbol.evidence_ids,
    }];

    const mermaid = renderAtlasMermaid(atlas);
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain("Core");
    expect(mermaid).toContain("1 files");
  });
});
