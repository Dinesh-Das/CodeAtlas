import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeId } from "../../src/graph/ids.js";
import { getJournalMode, openDatabase, verifyDatabase } from "../../src/storage/database.js";
import { upsertNode } from "../../src/storage/nodes.js";
import { searchNodes } from "../../src/storage/search.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite storage", () => {
  it("migrates in WAL mode and keeps FTS synchronized", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-db-"));
    roots.push(root);
    const database = openDatabase(path.join(root, "atlas.db"));
    try {
      expect(getJournalMode(database)).toBe("wal");
      expect(verifyDatabase(database)).toBe(true);
      expect(
        database.pragma("index_info(idx_resolved_edges_edge)") as Array<{ name: string }>,
      ).toEqual([expect.objectContaining({ name: "edge_id" })]);
      expect(
        database.pragma("index_info(idx_dependency_communities_node)") as Array<{ name: string }>,
      ).toEqual([expect.objectContaining({ name: "node_id" })]);
      expect(
        database.pragma("index_info(idx_edges_owner_file)") as Array<{ name: string }>,
      ).toEqual([
        expect.objectContaining({ name: "owner_kind" }),
        expect.objectContaining({ name: "file_path" }),
      ]);
      expect(
        database.pragma("table_info(file_semantics)") as Array<{ name: string }>,
      ).toContainEqual(expect.objectContaining({ name: "location_fingerprint" }));

      const id = createNodeId("repo", "file", "src/payment.ts", "src/payment.ts");
      upsertNode(
        database,
        {
          id,
          kind: "file",
          name: "payment.ts",
          qualifiedName: "src/payment.ts",
          filePath: "src/payment.ts",
          language: "typescript",
          startLine: null,
          startColumn: null,
          endLine: null,
          endColumn: null,
          signature: null,
          visibility: null,
          contentHash: "hash",
          sourceType: "git",
          confidence: 1,
          metadata: {},
        },
        new Date().toISOString(),
      );

      expect(searchNodes(database, "payment")).toEqual([
        expect.objectContaining({ id, filePath: "src/payment.ts" }),
      ]);
    } finally {
      database.close();
    }
  });
});
