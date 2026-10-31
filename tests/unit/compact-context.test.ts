import { describe, expect, it } from "vitest";
import { compactChangeContext, expandCompactContext } from "../../src/context/compact.js";
import { fitChangeContextToBudget } from "../../src/context/budgeter.js";
import type { ChangeContext } from "../../src/context/packet.js";
import { irResult } from "../../src/mcp/ir-tools.js";

function contextPacket(): ChangeContext {
  const id = `symbol:${"0123456789abcdef".repeat(4)}`;
  const proof = `evidence:${"fedcba9876543210".repeat(4)}`;
  const symbol = {
    id, kind: "function", name: "authenticate", qualified_name: "authenticate",
    file: "src/auth/service.ts", location: { start_line: 1, start_column: 0, end_line: 4, end_column: 1 },
    domain_ids: ["authentication"], visibility: "public", provenance_category: "verified" as const,
    evidence_ids: [proof],
  };
  return {
    schema_version: "1.2",
    snapshot: { id: "snapshot", fingerprint: "a".repeat(64), generations: { structural: 1, semantic: 1, search: 1, architecture: 1 } },
    task: `Change ${id}; keep literal i1 and f1 and 日本語`,
    intent: { kind: "feature", terms: ["authenticate"], explicit_symbols: [], explicit_files: [], explicit_endpoints: [], explicit_domains: [] },
    summary: "Inspect the authentication boundary.",
    change_candidates: [{ symbol, retrieval_reasons: ["exact symbol"], recommendation: { fact_class: "inference", action: "modify", rationale: "Inspect this function.", confidence: 0.9 }, supporting_paths: [], evidence_ids: [proof] }],
    edit_locations: [{ symbol_id: id, file: symbol.file, start_line: 1, end_line: 4, action: "modify", confidence: 0.9, evidence_ids: [proof] }],
    verified_paths: [{ classification: "verified", symbol_ids: [id, "caller"], relationship_ids: ["calls:1"], evidence_ids: [proof], confidence: 1 }],
    potential_paths: [{ classification: "potential", symbol_ids: [id, "dynamic-caller"], relationship_ids: ["calls:2"], evidence_ids: [proof], confidence: 0.3 }],
    relevant_flows: [], affected_contracts: [{ symbol, contract_kind: "api", evidence_ids: [proof] }],
    relevant_tests: [{ symbol, relationship: "direct", evidence_ids: [proof] }],
    constraints: [], invariants: [], validation_commands: [], verification_checklist: [],
    evidence: [{ id: proof, file: symbol.file, start_line: 1, start_column: 0, end_line: 4, end_column: 1, kind: "source", excerpt: `// ${id}: i1 f1 symbol_ref 日本語`, excerpt_status: "complete", trust: "untrusted_repository_content" }],
    gaps: [{ code: "dynamic_relationship", message: "Dispatch is dynamic; do not claim execution.", target: id, candidate_ids: [id], evidence_ids: [proof] }],
    budget: { requested: 12_000, used: 5_000, unit: "utf8_bytes_upper_bound", estimator: "utf8-bytes-upper-bound/v1", envelope_reserved: 0, format: "json" },
    coverage: { indexed_files: 3, indexed_symbols: 4, languages: ["typescript"], resolution_issues: 1, limitations: ["Dynamic dispatch remains unresolved."] },
    continuation: "Use get_evidence for source proof.", content_trust: "untrusted_repository_content",
  };
}

describe("compact change context", () => {
  it("shares identities and symbols without losing facts or rewriting source and task literals", () => {
    const packet = contextPacket();
    const original = structuredClone(packet);
    const compact = compactChangeContext(packet);
    expect(expandCompactContext(JSON.parse(JSON.stringify(compact)))).toEqual(packet);
    expect(packet).toEqual(original);
    expect(Object.keys(compact.symbols)).toHaveLength(1);
    expect(compact.context.evidence).toMatchObject({ columns: expect.arrayContaining(["id", "file", "excerpt"]), rows: expect.any(Array) });
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(packet).length * 0.85);
    expect(compactChangeContext(packet)).toEqual(compact);
  });

  it("rejects missing dictionary entries instead of silently changing a target", () => {
    const compact = compactChangeContext(contextPacket());
    delete compact.ids[Object.keys(compact.ids)[0]!];
    expect(() => expandCompactContext(compact)).toThrow(/reference/u);
  });

  it.each(["files", "symbols"] as const)("rejects missing %s references", (table) => {
    const compact = compactChangeContext(contextPacket());
    delete compact[table][Object.keys(compact[table])[0]!];
    expect(() => expandCompactContext(compact)).toThrow(/reference/u);
  });

  it.each([
    { columns: ["id"] },
    { columns: ["id"], rows: [["i1", "i2"]] },
    { columns: ["id", "id"], rows: [["i1", "i1"]] },
  ])("rejects malformed fact tables: %j", (table) => {
    const compact = compactChangeContext(contextPacket());
    compact.context.evidence = table;
    expect(() => expandCompactContext(compact)).toThrow(/reference/u);
  });

  it("rejects symbol-reference cycles and unsupported transport versions", () => {
    const compact = compactChangeContext(contextPacket());
    compact.symbols.s1 = { symbol_ref: "s1" };
    expect(() => expandCompactContext(compact)).toThrow(/reference/u);
    expect(() => expandCompactContext({ ...compact, format: "future" } as never)).toThrow(/format/u);
  });

  it("reports uncertainty and truncation from compact table facts in the MCP envelope", () => {
    const packet = contextPacket();
    packet.gaps.push({ code: "budget_truncated", message: "More context is available.", target: null, candidate_ids: [], evidence_ids: [] });
    const result = irResult(compactChangeContext(packet) as unknown as Record<string, unknown>);
    expect(result.structuredContent.codeatlas.coverage).toMatchObject({ bounded: true, truncated: true });
    expect(result.structuredContent.codeatlas.uncertainty.dynamic_references).toBe(1);
  });

  it("bounds the actual compact UTF-8 output and retains grounded targets", () => {
    const packet = contextPacket();
    const { change_candidates, edit_locations, verified_paths, potential_paths, relevant_flows,
      affected_contracts, relevant_tests, constraints, invariants, validation_commands,
      verification_checklist, gaps, budget: _budget, evidence, continuation: _continuation, ...base } = packet;
    const fitted = fitChangeContextToBudget(base, {
      change_candidates, edit_locations, verified_paths, potential_paths, relevant_flows,
      affected_contracts, relevant_tests, constraints, invariants, validation_commands,
      verification_checklist, gaps,
    }, evidence.map((item) => ({ ...item, symbol_id: null, relationship_id: null, resolution_issue_id: null, content_hash: null, file_content_hash: null, range_content_hash: null })), {
      requested: 4_000, format: "compact", envelopeReserve: 200,
    });
    const serialized = JSON.stringify(compactChangeContext(fitted));
    expect(Buffer.byteLength(serialized) + 200).toBe(fitted.budget.used);
    expect(fitted.budget.used).toBeLessThanOrEqual(4_000);
    expect(fitted.change_candidates[0]?.symbol.name).toBe("authenticate");
  });
});
