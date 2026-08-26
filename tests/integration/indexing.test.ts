import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStatus } from "../../src/cli/status.js";
import { initializeRepository } from "../../src/cli/init.js";
import { indexRepository } from "../../src/cli/index-command.js";
import { workspacePaths } from "../../src/core/workspace.js";
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
    await repository.write("src/payment.ts", "export function charge(): boolean { return true; }\n");
    await repository.write("src/app.py", "def main():\n    return True\n");
    await repository.write("package.json", '{"name":"fixture"}\n');
    await repository.write(".env", "SECRET=do-not-index\n");
    await repository.write("node_modules/dep/index.js", "module.exports = {};\n");
    await repository.git("add", "src", "package.json");
    await repository.git("commit", "-m", "fixture");

    const result = await initializeRepository(repository.root);
    const paths = workspacePaths(repository.root);

    expect(result.files).toBe(4); // .gitignore plus three repository files
    expect(result.languages).toMatchObject({ typescript: 1, python: 1, json: 1 });
    await expect(readFile(paths.config, "utf8")).resolves.toContain('"maxTraversalDepth": 10');
    await expect(readFile(paths.manifest, "utf8")).resolves.toContain(result.repository.id);
    await expect(readFile(paths.state, "utf8")).resolves.toContain(result.fingerprint);
    await expect(readFile(path.join(repository.root, ".gitignore"), "utf8")).resolves.toContain(
      ".codeatlas/",
    );

    const database = openDatabase(paths.database, { readonly: true });
    try {
      const indexedPaths = database
        .prepare("SELECT path FROM files ORDER BY path")
        .all()
        .map((row) => (row as { path: string }).path);
      expect(indexedPaths).toEqual([".gitignore", "package.json", "src/app.py", "src/payment.ts"]);
      expect(
        database.prepare("SELECT parse_status FROM files WHERE path = ?").pluck().get("src/payment.ts"),
      ).toBe("pending_parser");
      expect(database.prepare("SELECT count(*) FROM nodes").pluck().get()).toBeGreaterThan(4);
      expect(database.prepare("SELECT count(*) FROM edges").pluck().get()).toBeGreaterThan(3);
    } finally {
      database.close();
    }

    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
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
    await expect(indexRepository(repository.root, true)).resolves.toMatchObject({ files: 2 });
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
  });
});
