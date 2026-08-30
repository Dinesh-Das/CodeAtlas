import { afterEach, describe, expect, it } from "vitest";
import { buildRepository } from "../../src/compiler/build.js";
import { loadCurrentAtlas } from "../../src/cli/v2-query.js";
import { clearFastStatusCache, getStatus } from "../../src/cli/status.js";
import { workspaceExists } from "../../src/core/workspace.js";
import { findSymbolIr } from "../../src/mcp/ir-tools.js";
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
    architectureService.clear(repository.root);

    const first = await architectureService.load(repository.root);
    const cached = await architectureService.load(repository.root);
    expect(first.rebuilt).toBe(false);
    expect(first.cacheHit).toBe(false);
    expect(cached.cacheHit).toBe(true);
    expect(cached.atlas).toBe(first.atlas);

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

    const refreshed = await architectureService.load(repository.root);
    expect(refreshed.cacheHit).toBe(true);
    expect(refreshed.atlas).toBe(atlas);
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
