import { describe, expect, it } from "vitest";
import { fitChangeContextToBudget } from "../../src/context/budgeter.js";
import { validateChangeContextGrounding, type ChangeContext } from "../../src/context/packet.js";
import type { AtlasEvidence } from "../../src/ir/models.js";

function evidence(id: string, startLine: number, endLine: number): AtlasEvidence {
  return {
    id,
    file: "src/example.ts",
    start_line: startLine,
    start_column: 0,
    end_line: endLine,
    end_column: 1,
    kind: "source",
    excerpt: `lines ${startLine}-${endLine}`,
    excerpt_status: "complete",
    content_hash: null,
    file_content_hash: null,
    range_content_hash: null,
    symbol_id: null,
    relationship_id: null,
    resolution_issue_id: null,
  };
}

describe("change-context grounding", () => {
  it("preserves distinct evidence identities for overlapping source ranges", () => {
    const evidenceRecords = [evidence("proof-a", 1, 10), evidence("proof-b", 9, 20)];
    const empty = {
      change_candidates: [], verified_paths: [], potential_paths: [], relevant_flows: [],
      affected_contracts: [], relevant_tests: [], constraints: [], invariants: [],
      validation_commands: [], verification_checklist: [], gaps: [],
    };
    const packet = fitChangeContextToBudget({
      schema_version: "1.2",
      snapshot: {
        id: "snapshot", fingerprint: "a".repeat(64),
        generations: { structural: 1, semantic: 1, search: 1, architecture: 1 },
      },
      task: "Change both functions",
      intent: {
        kind: "feature", terms: ["functions"], explicit_symbols: [], explicit_files: [],
        explicit_endpoints: [], explicit_domains: [],
      },
      summary: "Two edits.",
      coverage: { indexed_files: 1, indexed_symbols: 2, languages: ["typescript"], resolution_issues: 0, limitations: [] },
      content_trust: "untrusted_repository_content",
    }, {
      ...empty,
      edit_locations: [
        { symbol_id: "a", file: "src/example.ts", start_line: 1, end_line: 10, action: "modify", confidence: 1, evidence_ids: ["proof-a"] },
        { symbol_id: "b", file: "src/example.ts", start_line: 9, end_line: 20, action: "modify", confidence: 1, evidence_ids: ["proof-b"] },
      ],
    }, evidenceRecords, { requested: 12_000, format: "json", envelopeReserve: 0 });

    expect(packet.edit_locations.map((item) => item.evidence_ids)).toEqual([["proof-a"], ["proof-b"]]);
    expect(packet.evidence.map((item) => item.id)).toEqual(["proof-a", "proof-b"]);
    expect(validateChangeContextGrounding(packet)).toEqual([]);
  });

  it("rejects evidence that does not cover an edit range", () => {
    const packet = {
      edit_locations: [{
        symbol_id: "b", file: "src/example.ts", start_line: 9, end_line: 20,
        action: "modify", confidence: 1, evidence_ids: ["proof-a"],
      }],
      evidence: [{
        id: "proof-a", file: "src/example.ts", start_line: 1, start_column: 0,
        end_line: 10, end_column: 1, kind: "source", excerpt: "partial",
        excerpt_status: "complete", trust: "untrusted_repository_content",
      }],
      change_candidates: [], verified_paths: [], potential_paths: [], relevant_flows: [],
      affected_contracts: [], relevant_tests: [], constraints: [], invariants: [],
      validation_commands: [], verification_checklist: [], gaps: [],
    } as unknown as ChangeContext;
    expect(validateChangeContextGrounding(packet)).toContain(
      "edit_locations.0 has no evidence covering its source range.",
    );
  });
});
