import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askRepository } from "../../src/cli/ask.js";
import { compileChangeContext } from "../../src/context/planner.js";
import { initializeRepository } from "../../src/cli/init.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

let repository: TestRepository;

beforeAll(async () => {
  repository = await createTestRepository();
  await repository.write("src/mcp/server.ts", [
    'import { canonicalMcpResult, findSymbolIr } from "./ir-tools.js";',
    'import { QueryStore } from "../storage/query-store.js";',
    "export function createCodeAtlasServer(query: string) {",
    "  const store = new QueryStore();",
    "  return canonicalMcpResult(findSymbolIr(store, query));",
    "}",
    "",
  ].join("\n"));
  await repository.write("src/mcp/ir-tools.ts", [
    'import { QueryStore } from "../storage/query-store.js";',
    "export function findSymbolIr(store: QueryStore, query: string) {",
    "  return store.searchSymbols(query);",
    "}",
    "export function canonicalMcpResult(value: unknown) { return irResult(value); }",
    "export function irResult(value: unknown) { return responseEnvelope(value); }",
    "export function responseEnvelope(value: unknown) {",
    "  return { result: value, evidence: [] as string[] };",
    "}",
    "",
  ].join("\n"));
  await repository.write("src/storage/query-store.ts", [
    "export class QueryStore {",
    "  searchSymbols(query: string) { return [{ name: query, evidence_ids: [] as string[] }]; }",
    "}",
    "",
  ].join("\n"));
  await repository.write("tests/mcp.test.ts", [
    'import { createCodeAtlasServer } from "../src/mcp/server.js";',
    'export function mcpFindSymbolTest() { return createCodeAtlasServer("symbol"); }',
    "",
  ].join("\n"));
  await repository.git("add", ".");
  await repository.git("commit", "-m", "agent context fixture");
  await initializeRepository(repository.root);
}, 30_000);

afterAll(async () => {
  await repository.remove();
});

describe("P0 agent context quality", () => {
  it("explains an MCP query as evidence-linked retrieval and response paths", async () => {
    const answer = await askRepository(
      "How does an MCP find_symbol request become an evidence-backed response?",
      repository.root,
    );

    expect(answer.answer).toContain("createCodeAtlasServer");
    expect(answer.answer).toContain("findSymbolIr");
    expect(answer.answer).toContain("QueryStore.searchSymbols");
    expect(answer.answer).toContain("irResult");
    expect(answer.claims.filter((claim) => claim.fact_class === "graph_inference").length)
      .toBeGreaterThanOrEqual(2);
    expect(answer.claims.every((claim) => claim.evidence_ids.length > 0)).toBe(true);
  });

  it("prioritizes change targets and affected tests ahead of resolution noise", async () => {
    const packet = await compileChangeContext(
      "Add a new MCP query that explains how indexed retrieval becomes evidence-backed output",
      repository.root,
      { budget: 12_000, format: "json" },
    );
    const files = new Set([
      ...packet.change_candidates.map((candidate) => candidate.symbol.file),
      ...packet.verified_paths.flatMap((path) => path.symbol_ids.flatMap((id) =>
        packet.change_candidates.find((candidate) => candidate.symbol.id === id)?.symbol.file ?? []
      )),
      ...packet.evidence.map((item) => item.file),
    ]);

    expect(files.has("src/mcp/server.ts")).toBe(true);
    expect(files.has("src/mcp/ir-tools.ts")).toBe(true);
    expect(files.has("src/storage/query-store.ts")).toBe(true);
    expect(packet.relevant_tests.map((test) => test.symbol.file)).toContain("tests/mcp.test.ts");
    expect(packet.change_candidates[0]?.symbol.kind).not.toBe("variable");
  });

  it("keeps a source-backed target in a 3000-byte packet", async () => {
    const packet = await compileChangeContext(
      "Change findSymbolIr retrieval behavior",
      repository.root,
      { budget: 3_000, format: "json" },
    );

    expect(packet.budget.used).toBeLessThanOrEqual(3_000);
    expect(packet.change_candidates[0]?.symbol.name).toBe("findSymbolIr");
  });

  it("exposes callers, affected tests, and unsupported requests", async () => {
    const impact = await compileChangeContext(
      "Identify impact and affected tests when findSymbolIr changes",
      repository.root,
      { budget: 7_000, format: "json" },
    );
    expect(impact.verified_paths.length).toBeGreaterThan(0);
    expect(impact.relevant_tests.map((test) => test.symbol.file)).toContain("tests/mcp.test.ts");

    const unsupported = await compileChangeContext(
      "Change the quantum payroll blockchain reconciler",
      repository.root,
      { budget: 3_000, format: "json" },
    );
    expect(unsupported.change_candidates).toEqual([]);
    expect(unsupported.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported_coverage" }),
    ]));
  });
});
