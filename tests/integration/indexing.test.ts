import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStatus } from "../../src/cli/status.js";
import { initializeRepository } from "../../src/cli/init.js";
import { indexRepository } from "../../src/cli/index-command.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { INDEX_PHASES } from "../../src/core/telemetry.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("repository → index → graph", () => {
  it("initializes a valid local workspace and structural graph", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/payment.ts",
      'const apiKey = "must-not-store";\nexport function charge(): boolean { return true; }\n',
    );
    await repository.write("src/app.py", "def main():\n    return True\n");
    await repository.write("package.json", '{"name":"fixture"}\n');
    await repository.write(".env", "SECRET=do-not-index\n");
    await repository.write("node_modules/dep/index.js", "module.exports = {};\n");
    await repository.git("add", "src", "package.json");
    await repository.git("commit", "-m", "fixture");

    const result = await initializeRepository(repository.root);
    const paths = workspacePaths(repository.root);

    expect(result.files).toBe(3);
    expect(result.symbols).toBeGreaterThanOrEqual(3);
    expect(result.languages).toMatchObject({ typescript: 1, python: 1, json: 1 });
    expect(result.phaseMetrics.map((metric) => metric.phase)).toEqual(INDEX_PHASES);
    expect(result.peakRssBytes).toBeGreaterThan(0);
    expect(
      result.phaseMetrics.find((metric) => metric.phase === "repository_discovery"),
    ).toMatchObject({ itemsProcessed: 3 });
    await expect(readFile(paths.config, "utf8")).resolves.toContain('"maxTraversalDepth": 10');
    await expect(readFile(paths.manifest, "utf8")).resolves.toContain(result.repository.id);
    const storedState = await readFile(paths.state, "utf8");
    expect(storedState).toContain(result.fingerprint);
    expect(storedState).toContain('"phaseMetrics"');
    await expect(readFile(path.join(repository.root, ".gitignore"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(repository.git("status", "--short", "--", ".gitignore")).resolves.toBe("");

    const database = openDatabase(paths.database, { readonly: true });
    try {
      const indexedPaths = database
        .prepare("SELECT path FROM files ORDER BY path")
        .all()
        .map((row) => (row as { path: string }).path);
      expect(indexedPaths).toEqual(["package.json", "src/app.py", "src/payment.ts"]);
      expect(
        database.prepare("SELECT parse_status FROM files WHERE path = ?").pluck().get("src/payment.ts"),
      ).toBe("parsed");
      const symbols = database
        .prepare(
          "SELECT kind, qualified_name AS qualifiedName, source_type AS sourceType, start_line AS startLine FROM nodes WHERE file_path = ? ORDER BY start_line, kind",
        )
        .all("src/payment.ts") as Array<Record<string, unknown>>;
      expect(symbols).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "function", qualifiedName: "charge", sourceType: "ast" }),
          expect.objectContaining({ kind: "variable", qualifiedName: "apiKey", sourceType: "ast" }),
        ]),
      );
      const storedMetadata = JSON.stringify(
        database
          .prepare("SELECT signature, metadata_json FROM nodes WHERE file_path = ?")
          .all("src/payment.ts"),
      );
      expect(storedMetadata).not.toContain("must-not-store");
      const exportEvidence = database
        .prepare(
          `SELECT edges.source_type AS sourceType, edges.file_path AS filePath,
                  edges.line, edges.metadata_json AS metadataJson
           FROM edges
           JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type = 'EXPORTS' AND target.qualified_name = 'charge'`,
        )
        .get() as { sourceType: string; filePath: string; line: number; metadataJson: string };
      expect(exportEvidence).toMatchObject({
        sourceType: "ast",
        filePath: "src/payment.ts",
        line: 2,
      });
      expect(JSON.parse(exportEvidence.metadataJson)).toHaveProperty(
        "evidence.file",
        "src/payment.ts",
      );
      expect(database.prepare("SELECT count(*) FROM nodes").pluck().get()).toBeGreaterThan(4);
      expect(database.prepare("SELECT count(*) FROM edges").pluck().get()).toBeGreaterThan(3);
    } finally {
      database.close();
    }

    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 0,
      symbols: result.symbols,
    });
  });

  it("detects working-tree changes and updates file metadata incrementally", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/payment.ts", "export const payment = 'v1';\n");
    await repository.write("src/obsolete.ts", "export const obsolete = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "fixture");
    await initializeRepository(repository.root);

    await repository.write("src/payment.ts", "export const payment = 'v2';\n");
    await rm(path.join(repository.root, "src", "obsolete.ts"));
    await repository.write("src/new.ts", "export const fresh = true;\n");
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: false, dirty: true });

    const result = await indexRepository(repository.root);
    expect(result.changedFiles).toBe(2);
    expect(result.deletedFiles).toBe(1);
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const paths = database
        .prepare("SELECT path FROM files ORDER BY path")
        .all()
        .map((row) => (row as { path: string }).path);
      expect(paths).toContain("src/new.ts");
      expect(paths).not.toContain("src/obsolete.ts");
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE qualified_name = 'obsolete'").pluck().get(),
      ).toBe(0);
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE qualified_name = 'payment'").pluck().get(),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("preserves parsed containment for unchanged files during an incremental update", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/a.ts", "export function alpha(): boolean { return true; }\n");
    await repository.write("src/b.ts", "export function beta(): boolean { return true; }\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "fixture");
    await initializeRepository(repository.root);

    await repository.write("src/b.ts", "export function betaChanged(): boolean { return false; }\n");
    const result = await indexRepository(repository.root);
    expect(result.changedFiles).toBe(1);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             JOIN nodes target ON target.id = edges.target_node_id
             WHERE edges.edge_type = 'CONTAINS' AND target.qualified_name = 'alpha'`,
          )
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE qualified_name = 'beta'").pluck().get(),
      ).toBe(0);
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE qualified_name = 'betaChanged'").pluck().get(),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("requires an explicit full rebuild to recover a corrupt database", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/index.ts", "export const ready = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "fixture");
    await initializeRepository(repository.root);

    const databasePath = workspacePaths(repository.root).database;
    await writeFile(databasePath, "not a sqlite database", "utf8");

    await expect(indexRepository(repository.root)).rejects.toThrow("could not be opened");
    await expect(indexRepository(repository.root, true)).resolves.toMatchObject({ files: 1 });
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
  });

  it("records syntax diagnostics without storing stale symbols", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("broken.py", "def broken(:\n    return True\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "fixture");

    const result = await initializeRepository(repository.root);
    expect(result.parseErrors).toBe(1);
    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      expect(
        database.prepare("SELECT parse_status FROM files WHERE path = 'broken.py'").pluck().get(),
      ).toBe("parsed_with_errors");
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE file_path = 'broken.py'").pluck().get(),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      database.close();
    }
  });
});
