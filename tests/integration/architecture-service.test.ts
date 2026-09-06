import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepository } from "../../src/compiler/build.js";
import { loadCurrentAtlas } from "../../src/cli/v2-query.js";
import { clearFastStatusCache, getStatus } from "../../src/cli/status.js";
import { workspaceExists } from "../../src/core/workspace.js";
import { controlFlowIr, evidenceIr, findSymbolIr, irResult } from "../../src/mcp/ir-tools.js";
import { architectureService } from "../../src/service/architecture-service.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    architectureService.clear(repository.root);
    clearFastStatusCache(repository.root);
    await repository.remove();
  }
});

async function committedRepository(source: string): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await repository.write("src/service.ts", source);
  await repository.git("add", ".");
  await repository.git("commit", "-m", "architecture service fixture");
  return repository;
}

describe("ArchitectureService", () => {
  it("automatically initializes a repository for canonical CLI queries", async () => {
    const repository = await committedRepository(
      "export function initializeMe(): boolean { return true; }\n",
    );

    expect(await workspaceExists(repository.root)).toBe(false);
    const atlas = await loadCurrentAtlas(repository.root);

    expect(atlas.symbols.some((symbol) => symbol.qualified_name === "initializeMe")).toBe(true);
    expect(await workspaceExists(repository.root)).toBe(true);
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
  }, 60_000);

  it("refreshes stale CLI and MCP reads and caches one canonical generation", async () => {
    const repository = await committedRepository(
      "export function oldOperation(): boolean { return true; }\n",
    );
    await buildRepository(repository.root, { snapshot: false });
    const exportedBeforeQuery = await Promise.all([
      readFile(path.join(repository.root, "codeatlas.html"), "utf8"),
      readFile(path.join(repository.root, "CODEATLAS.md"), "utf8"),
      readFile(path.join(repository.root, "CODEATLAS.mmd"), "utf8"),
      readFile(path.join(repository.root, ".codeatlas", "current", "atlas.json"), "utf8"),
    ]);
    architectureService.clear(repository.root);

    const first = await architectureService.load(repository.root);
    const cached = await architectureService.load(repository.root);
    expect(first.rebuilt).toBe(false);
    expect(first.cacheHit).toBe(false);
    expect(cached.cacheHit).toBe(true);
    expect(cached.atlas).toBe(first.atlas);
    expect(cached.projection).toBe(first.projection);
    const oldOperation = first.atlas.symbols.find((symbol) => symbol.qualified_name === "oldOperation")!;
    expect(first.projection.symbolById.get(oldOperation.id)).toBe(oldOperation);
    expect(oldOperation.evidence_ids.map((id) => first.projection.evidenceById.get(id)?.id))
      .toEqual(oldOperation.evidence_ids);
    for (const relationship of first.atlas.relationships) {
      expect(first.projection.outgoingBySymbolId.get(relationship.source)).toContain(relationship);
      expect(first.projection.incomingBySymbolId.get(relationship.target)).toContain(relationship);
    }
    expect(first.timingsMs.freshness).toBeGreaterThanOrEqual(0);
    expect(first.timingsMs.retrieval).toBeGreaterThanOrEqual(0);
    expect(first.timingsMs.projection).toBeGreaterThanOrEqual(0);
    expect(cached.timingsMs.projection).toBe(0);

    await repository.write(
      "src/service.ts",
      "export function newOperation(): boolean { return false; }\n",
    );

    const [atlas, found] = await Promise.all([
      loadCurrentAtlas(repository.root),
      findSymbolIr(repository.root, "newOperation", 10),
    ]);
    expect(atlas.symbols.some((symbol) => symbol.qualified_name === "newOperation")).toBe(true);
    expect(atlas.symbols.some((symbol) => symbol.qualified_name === "oldOperation")).toBe(false);
    expect(found.results.some((symbol) => symbol.qualified_name === "newOperation")).toBe(true);
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
    await expect(Promise.all([
      readFile(path.join(repository.root, "codeatlas.html"), "utf8"),
      readFile(path.join(repository.root, "CODEATLAS.md"), "utf8"),
      readFile(path.join(repository.root, "CODEATLAS.mmd"), "utf8"),
      readFile(path.join(repository.root, ".codeatlas", "current", "atlas.json"), "utf8"),
    ])).resolves.toEqual(exportedBeforeQuery);

    const refreshed = await architectureService.load(repository.root);
    expect(refreshed.cacheHit).toBe(true);
    expect(refreshed.atlas).toBe(atlas);
  }, 60_000);

  it("uses indexed candidates while retaining source-evidence vocabulary", async () => {
    const repository = await committedRepository(
      "export function indexedOperation(): string { return 'quantum platypus marker'; }\n",
    );
    await buildRepository(repository.root, { snapshot: false });
    architectureService.clear(repository.root);

    const indexed = await findSymbolIr(repository.root, "indexedOperation", 10) as {
      results: Array<{ qualified_name: string | null }>;
      retrieval: { strategy: string; indexed_candidates: number };
    };
    expect(indexed.results.some((symbol) => symbol.qualified_name === "indexedOperation")).toBe(true);
    expect(indexed.retrieval).toMatchObject({
      strategy: "sqlite_fts_name_path+generation_projection",
      indexed_candidates: expect.any(Number),
    });

    const evidenceMatch = await findSymbolIr(repository.root, "quantum platypus", 10) as {
      results: Array<{ qualified_name: string | null }>;
    };
    expect(evidenceMatch.results.some((symbol) => symbol.qualified_name === "indexedOperation")).toBe(true);

    const response = irResult(await findSymbolIr(repository.root, "indexedOperation", 10));
    expect(response.structuredContent.codeatlas.performance).toMatchObject({
      timings_ms: {
        freshness: expect.any(Number),
        retrieval: expect.any(Number),
        projection: expect.any(Number),
        serialization: expect.any(Number),
        transport: expect.any(Number),
      },
      transport_scope: "response_construction",
    });
  }, 60_000);

  it("builds a control-flow projection on demand beyond the eager generation bound", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/many-functions.ts",
      Array.from({ length: 305 }, (_, index) =>
        `export function operation${index}(value: boolean): number { if (value) return ${index}; return -1; }`
      ).join("\n") + "\n",
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "many functions fixture");
    const build = await buildRepository(repository.root, { snapshot: false });
    const persisted = JSON.parse(
      await readFile(path.join(build.currentDirectory, "atlas.json"), "utf8"),
    ) as {
      symbols: Array<{ id: string; kind: string; qualified_name: string | null }>;
      control_flows: Array<{ symbol_id: string }>;
    };
    expect(persisted.control_flows).toHaveLength(300);
    const eager = new Set(persisted.control_flows.map((flow) => flow.symbol_id));
    const missing = persisted.symbols.find((symbol) =>
      symbol.kind === "function" && !eager.has(symbol.id)
    )!;
    architectureService.clear(repository.root);

    const result = await controlFlowIr(repository.root, missing.id);
    expect(result).toMatchObject({
      symbol: { id: missing.id },
      generation: "on_demand",
      control_flow: {
        symbol_id: missing.id,
        analysis_kind: "structured_ast_approximation",
        supported_constructs: expect.arrayContaining(["if", "return"]),
      },
    });
    const evidenceId = result.control_flow!.nodes.find((node) => node.kind === "CONDITION")!.evidence_ids[0]!;
    await expect(evidenceIr(repository.root, evidenceId)).resolves.toMatchObject({
      evidence: [expect.objectContaining({ id: evidenceId, symbol_id: missing.id })],
      retrieval: { source: "generation_projection" },
    });
  }, 60_000);

  it("invalidates a cached atlas when architecture configuration changes", async () => {
    const repository = await committedRepository(
      "export function configuredOperation(): boolean { return true; }\n",
    );
    await buildRepository(repository.root, { snapshot: false });
    architectureService.clear(repository.root);

    const before = await architectureService.load(repository.root);
    expect(before.atlas.domains.some((domain) => domain.name === "configured-domain")).toBe(false);

    await repository.write(
      ".codeatlas.yml",
      [
        "version: 1",
        "domains:",
        "  configured-domain:",
        "    include:",
        "      - src/**",
        "",
      ].join("\n"),
    );

    const after = await architectureService.load(repository.root);
    expect(after.cacheHit).toBe(false);
    expect(after.rebuilt).toBe(true);
    expect(after.atlas.domains.some((domain) => domain.name === "configured-domain")).toBe(true);
  }, 60_000);
});
