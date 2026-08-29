import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { indexRepository } from "../../src/cli/index-command.js";
import { clearFastStatusCache, getFastStatus, getStatus } from "../../src/cli/status.js";
import { runIndex } from "../../src/indexer/indexer.js";
import { ensureFreshIndex } from "../../src/mcp/freshness.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("Phase 4 incremental indexing", () => {
  it("keeps structural facts usable and repairs architecture after a post-commit crash", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/crash.ts",
      "export function version(value: number): number { return value; }\n",
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "crash generation fixture");
    await initializeRepository(repository.root);

    await repository.write(
      "src/crash.ts",
      "export function version(value: string): string { return value; }\n",
    );
    await expect(
      runIndex({
        startPath: repository.root,
        afterStructuralCommit() {
          throw new Error("simulated architecture crash");
        },
      }),
    ).rejects.toThrow("simulated architecture crash");

    await expect(getStatus(repository.root)).resolves.toMatchObject({
      synchronized: false,
      structuralSynchronized: true,
      semanticSynchronized: true,
      searchSynchronized: true,
      architectureSynchronized: false,
      generations: { structural: 2, semantic: 2, search: 2, architecture: 1 },
    });
    const structural = await ensureFreshIndex(repository.root, "structural");
    expect(structural.status.architectureSynchronized).toBe(false);

    const recovered = await ensureFreshIndex(repository.root, "architecture");
    expect(recovered.status).toMatchObject({
      synchronized: true,
      architectureSynchronized: true,
      generations: { structural: 2, semantic: 2, search: 2, architecture: 2 },
    });

    const firstCachedStatus = await getFastStatus(repository.root);
    const secondCachedStatus = await getFastStatus(repository.root);
    expect(secondCachedStatus).toStrictEqual(firstCachedStatus);
    expect(secondCachedStatus.freshnessMode).toBe("watch_cache");
    expect(secondCachedStatus.generations).toEqual({
      structural: 2,
      semantic: 2,
      search: 2,
      architecture: 2,
    });
    clearFastStatusCache(repository.root);
  });

  it("falls back to a full reconciliation when bounded invalidation truncates", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/shared.ts", "export const shared = 1;\n");
    await repository.write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
    );
    for (let index = 0; index < 15; index += 1) {
      await repository.write(
        `src/consumer-${index}.ts`,
        `import { shared } from "./shared.js";\nexport const value${index} = shared;\n`,
      );
    }
    await repository.git("add", ".");
    await repository.git("commit", "-m", "bounded invalidation fixture");
    await initializeRepository(repository.root);

    const configPath = workspacePaths(repository.root).config;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      limits: { maxInvalidationFiles: number };
    };
    config.limits.maxInvalidationFiles = 10;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await indexRepository(repository.root);

    await repository.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
        },
      }),
    );
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      fullRebuild: true,
      invalidationTruncated: true,
      invalidationTruncationReason: "max_files",
      changedFiles: 17,
    });
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
  });

  it("detects committed changes since the indexed commit without forcing a rebuild", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/version.ts", "export const version = 1;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "version one");
    await initializeRepository(repository.root);

    await repository.write("src/version.ts", "export const version = 2;\n");
    await repository.git("add", "src/version.ts");
    await repository.git("commit", "-m", "version two");
    await expect(getStatus(repository.root)).resolves.toMatchObject({
      synchronized: false,
      dirty: false,
    });
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      changedFiles: 1,
      modifiedFiles: 1,
      fullRebuild: false,
    });
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
  });

  it("uses content hashes when Git hides a tracked working-tree modification", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/hidden.ts", "export const hidden = 1;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "hash fixture");
    await initializeRepository(repository.root);
    await repository.git("update-index", "--assume-unchanged", "src/hidden.ts");

    await repository.write("src/hidden.ts", "export const hidden = 2;\n");
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: false });
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({ changedFiles: 1, modifiedFiles: 1 });
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
  });

  it("automatically rebuilds when indexed Git history is no longer ancestral", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/history.ts", "export const history = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "original history");
    await initializeRepository(repository.root);

    await repository.git("checkout", "--orphan", "disconnected-history");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "disconnected history");
    const result = await indexRepository(repository.root);
    expect(result.fullRebuild).toBe(true);
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
  });

  it("automatically rebuilds for incompatible schema and parser state", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/versioned.ts", "export const versioned = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "versioned index fixture");
    await initializeRepository(repository.root);

    const databasePath = workspacePaths(repository.root).database;
    const schemaDatabase = openDatabase(databasePath);
    schemaDatabase
      .prepare("UPDATE repository_state SET value = '0' WHERE key = 'schema_version'")
      .run();
    schemaDatabase.close();
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      fullRebuild: true,
    });

    const parserDatabase = openDatabase(databasePath);
    parserDatabase
      .prepare("UPDATE files SET parser_version = 'incompatible-parser'")
      .run();
    parserDatabase.close();
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      fullRebuild: true,
    });
  });

  it("reports an outdated database schema without running incompatible diagnostics", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/versioned.ts", "export const versioned = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "outdated doctor fixture");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database);
    database.prepare("DELETE FROM schema_migrations WHERE version >= 4").run();
    database.close();

    const checks = await runDoctor(repository.root);
    expect(checks.filter((check) => check.name === "SQLite")).toEqual([
      expect.objectContaining({
        ok: false,
        detail: expect.stringContaining("run `codeatlas index --full`"),
      }),
    ]);
    expect(checks.some((check) => check.name === "Dynamic relationships")).toBe(false);
  });

  it("reindexes the reverse dependency neighborhood without touching unrelated files", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/service.ts",
      "export function operation(): boolean { return true; }\n",
    );
    await repository.write(
      "src/caller.ts",
      'import { operation } from "./service.js";\nexport function callService(): boolean { return operation(); }\n',
    );
    await repository.write(
      "src/upstream.ts",
      'import { callService } from "./caller.js";\nexport function entrypoint(): boolean { return callService(); }\n',
    );
    await repository.write("src/unrelated.ts", "export const unrelated = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "dependency fixture");
    await initializeRepository(repository.root);

    const databasePath = workspacePaths(repository.root).database;
    const before = openDatabase(databasePath, { readonly: true });
    const indexedBefore = new Map(
      (
        before
          .prepare("SELECT path, indexed_at FROM files WHERE path LIKE 'src/%' ORDER BY path")
          .all() as Array<{ path: string; indexed_at: string }>
      ).map((row) => [row.path, row.indexed_at]),
    );
    const unrelatedNodeUpdatedAt = before
      .prepare("SELECT updated_at FROM nodes WHERE kind = 'file' AND file_path = 'src/unrelated.ts'")
      .pluck()
      .get() as string;
    const sourceDirectoryUpdatedAt = before
      .prepare("SELECT updated_at FROM nodes WHERE kind = 'directory' AND file_path = 'src'")
      .pluck()
      .get() as string;
    const unrelatedContainmentUpdatedAt = before
      .prepare(
        "SELECT updated_at FROM edges WHERE edge_type = 'CONTAINS' AND file_path = 'src/unrelated.ts'",
      )
      .pluck()
      .get() as string;
    before.close();

    await repository.write(
      "src/service.ts",
      "export function replacement(): boolean { return false; }\n",
    );
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      changedFiles: 1,
      addedFiles: 0,
      modifiedFiles: 1,
      deletedFiles: 0,
      renamedFiles: 0,
      invalidatedFiles: 1,
      fullRebuild: false,
      dirtyWorkingTree: true,
    });

    const database = openDatabase(databasePath, { readonly: true });
    try {
      const indexedAfter = new Map(
        (
          database
            .prepare("SELECT path, indexed_at FROM files WHERE path LIKE 'src/%' ORDER BY path")
            .all() as Array<{ path: string; indexed_at: string }>
        ).map((row) => [row.path, row.indexed_at]),
      );
      expect(indexedAfter.get("src/service.ts")).not.toBe(indexedBefore.get("src/service.ts"));
      expect(indexedAfter.get("src/caller.ts")).toBe(indexedBefore.get("src/caller.ts"));
      expect(indexedAfter.get("src/upstream.ts")).toBe(indexedBefore.get("src/upstream.ts"));
      expect(indexedAfter.get("src/unrelated.ts")).toBe(indexedBefore.get("src/unrelated.ts"));
      expect(
        database
          .prepare("SELECT updated_at FROM nodes WHERE kind = 'file' AND file_path = 'src/unrelated.ts'")
          .pluck()
          .get(),
      ).toBe(unrelatedNodeUpdatedAt);
      expect(
        database
          .prepare("SELECT updated_at FROM nodes WHERE kind = 'directory' AND file_path = 'src'")
          .pluck()
          .get(),
      ).toBe(sourceDirectoryUpdatedAt);
      expect(
        database
          .prepare(
            "SELECT updated_at FROM edges WHERE edge_type = 'CONTAINS' AND file_path = 'src/unrelated.ts'",
          )
          .pluck()
          .get(),
      ).toBe(unrelatedContainmentUpdatedAt);
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE qualified_name = 'operation'").pluck().get(),
      ).toBe(0);
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE qualified_name = 'replacement'").pluck().get(),
      ).toBe(1);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             JOIN nodes target ON target.id = edges.target_node_id
             WHERE edges.edge_type = 'CALLS' AND target.qualified_name = 'operation'`,
          )
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("revisits an unresolved importer when its missing module is added", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/consumer.ts",
      'import { later } from "./later.js";\nexport function consume(): boolean { return later(); }\n',
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "unresolved import fixture");
    await initializeRepository(repository.root);

    await repository.write(
      "src/later.ts",
      "export function later(): boolean { return true; }\n",
    );
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      changedFiles: 1,
      addedFiles: 1,
      modifiedFiles: 0,
      invalidatedFiles: 1,
    });

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             JOIN nodes source ON source.id = edges.source_node_id
             JOIN nodes target ON target.id = edges.target_node_id
             WHERE edges.edge_type = 'CALLS'
               AND source.qualified_name = 'consume'
               AND target.qualified_name = 'later'`,
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM resolution_issues
             WHERE file_path = 'src/consumer.ts' AND reference_kind = 'import'`,
          )
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("preserves graph identity for Git renames at or above 50% similarity", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/service.ts",
      "export function charge(): boolean { return true; }\n",
    );
    await repository.write(
      "src/caller.ts",
      'import { charge } from "./service.js";\nexport function checkout(): boolean { return charge(); }\n',
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "rename fixture");
    await initializeRepository(repository.root);

    const databasePath = workspacePaths(repository.root).database;
    const before = openDatabase(databasePath, { readonly: true });
    const identities = before
      .prepare(
        `SELECT id, kind, created_at AS createdAt
         FROM nodes
         WHERE file_path = 'src/service.ts' AND kind NOT IN ('feature', 'domain')
         ORDER BY kind`,
      )
      .all() as Array<{ id: string; kind: string; createdAt: string }>;
    before.close();

    await repository.git("mv", "src/service.ts", "src/payment-service.ts");
    await repository.write(
      "src/caller.ts",
      'import { charge } from "./payment-service.js";\nexport function checkout(): boolean { return charge(); }\n',
    );
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      changedFiles: 2,
      addedFiles: 0,
      modifiedFiles: 1,
      deletedFiles: 0,
      renamedFiles: 1,
      invalidatedFiles: 0,
      fullRebuild: false,
    });

    const database = openDatabase(databasePath, { readonly: true });
    try {
      const renamed = database
        .prepare(
          `SELECT id, kind, created_at AS createdAt
           FROM nodes
           WHERE file_path = 'src/payment-service.ts' AND kind NOT IN ('feature', 'domain')
           ORDER BY kind`,
        )
        .all() as Array<{ id: string; kind: string; createdAt: string }>;
      expect(renamed).toEqual(identities);
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE file_path = 'src/service.ts'").pluck().get(),
      ).toBe(0);
      const renameEdges = database
        .prepare(
          `SELECT source_type AS sourceType, confidence, metadata_json AS metadataJson
           FROM edges WHERE edge_type = 'RENAMED_FROM'`,
        )
        .all() as Array<{ sourceType: string; confidence: number; metadataJson: string }>;
      expect(renameEdges).toHaveLength(identities.length);
      for (const edge of renameEdges) {
        expect(edge).toMatchObject({ sourceType: "git", confidence: 0.95 });
        expect(JSON.parse(edge.metadataJson)).toMatchObject({
          previous_path: "src/service.ts",
          current_path: "src/payment-service.ts",
          git_similarity: 1,
        });
      }
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             JOIN nodes target ON target.id = edges.target_node_id
             WHERE edges.edge_type = 'IMPORTS' AND target.file_path = 'src/payment-service.ts'`,
          )
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      database.close();
    }

    await repository.git("mv", "src/payment-service.ts", "src/billing-service.ts");
    await repository.write(
      "src/caller.ts",
      'import { charge } from "./billing-service.js";\nexport function checkout(): boolean { return charge(); }\n',
    );
    const secondRename = await indexRepository(repository.root);
    expect(secondRename).toMatchObject({ renamedFiles: 1, modifiedFiles: 1 });
    const afterSecondRename = openDatabase(databasePath, { readonly: true });
    try {
      const renamedAgain = afterSecondRename
        .prepare(
          `SELECT id, kind, created_at AS createdAt
           FROM nodes
           WHERE file_path = 'src/billing-service.ts' AND kind NOT IN ('feature', 'domain')
           ORDER BY kind`,
        )
        .all() as Array<{ id: string; kind: string; createdAt: string }>;
      expect(renamedAgain).toEqual(identities);
      expect(
        afterSecondRename
          .prepare("SELECT count(*) FROM edges WHERE edge_type = 'RENAMED_FROM'")
          .pluck()
          .get(),
      ).toBe(identities.length * 2);
    } finally {
      afterSecondRename.close();
    }
  });

  it("treats a low-similarity move as delete plus create", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/original.ts",
      Array.from({ length: 20 }, (_, index) => `export const old${index} = ${index};`).join("\n") + "\n",
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "low similarity fixture");
    await initializeRepository(repository.root);

    const databasePath = workspacePaths(repository.root).database;
    const before = openDatabase(databasePath, { readonly: true });
    const previousId = before
      .prepare("SELECT id FROM nodes WHERE kind = 'file' AND file_path = 'src/original.ts'")
      .pluck()
      .get() as string;
    before.close();

    await repository.git("mv", "src/original.ts", "src/replacement.ts");
    await repository.write(
      "src/replacement.ts",
      Array.from({ length: 20 }, (_, index) => `export function fresh${index}(): string { return String(${index}); }`).join("\n") + "\n",
    );
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      addedFiles: 1,
      deletedFiles: 1,
      renamedFiles: 0,
    });

    const database = openDatabase(databasePath, { readonly: true });
    try {
      const currentId = database
        .prepare("SELECT id FROM nodes WHERE kind = 'file' AND file_path = 'src/replacement.ts'")
        .pluck()
        .get() as string;
      expect(currentId).not.toBe(previousId);
      expect(database.prepare("SELECT count(*) FROM edges WHERE edge_type = 'RENAMED_FROM'").pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("removes deleted graph entities transactionally", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/deleted.ts", "export function removed(): void {}\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "deletion fixture");
    await initializeRepository(repository.root);

    await rm(path.join(repository.root, "src", "deleted.ts"));
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({ deletedFiles: 1, renamedFiles: 0 });
    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE file_path = 'src/deleted.ts'").pluck().get(),
      ).toBe(0);
      expect(
        database.prepare("SELECT count(*) FROM edges WHERE file_path = 'src/deleted.ts'").pluck().get(),
      ).toBe(0);
      expect(
        database
          .prepare("SELECT count(*) FROM nodes WHERE kind = 'directory' AND file_path = 'src'")
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});
