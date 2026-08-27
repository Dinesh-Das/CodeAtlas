import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { indexRepository } from "../../src/cli/index-command.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

interface ExpectedFrameworkGraph {
  apiRoutes: number;
  databaseModels: number;
  frameworks: string[];
  nodes: string[];
}

const repositories: TestRepository[] = [];
const fixtureRoot = path.resolve("tests", "fixtures", "frameworks");

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

async function createFrameworkRepository(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  const fixtures = [
    ["src/routes.ts", "express/routes.ts"],
    ["api/routes.py", "fastapi/routes.py"],
    ["prisma/schema.prisma", "prisma/schema.prisma"],
    ["models/models.py", "sqlalchemy/models.py"],
  ] as const;
  for (const [target, source] of fixtures) {
    await repository.write(target, await readFile(path.join(fixtureRoot, source), "utf8"));
  }
  await repository.git("add", ".");
  await repository.git("commit", "-m", "framework fixture");
  return repository;
}

describe("Phase 5 framework adapters", () => {
  it("extracts known API routes and database models with evidence", async () => {
    const repository = await createFrameworkRepository();
    const expected = JSON.parse(
      await readFile(path.join(fixtureRoot, "expected.json"), "utf8"),
    ) as ExpectedFrameworkGraph;
    const result = await initializeRepository(repository.root);
    expect(result).toMatchObject({
      apiRoutes: expected.apiRoutes,
      databaseModels: expected.databaseModels,
      frameworks: expected.frameworks,
    });

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const rows = database
        .prepare(
          `SELECT kind, name, file_path AS filePath, start_line AS startLine,
                  source_type AS sourceType, confidence, metadata_json AS metadataJson
           FROM nodes
           WHERE kind IN ('api_route', 'database_model')
           ORDER BY file_path, start_line, kind`,
        )
        .all() as Array<{
          kind: string;
          name: string;
          filePath: string;
          startLine: number;
          sourceType: string;
          confidence: number;
          metadataJson: string;
        }>;
      const compact = rows.map((row) => {
        const framework = (JSON.parse(row.metadataJson) as { framework: string }).framework;
        return [
          row.kind,
          framework,
          row.name,
          path.posix.basename(row.filePath),
          row.startLine,
          row.sourceType,
          row.confidence,
        ].join("|");
      });
      expect(compact.sort()).toEqual(expected.nodes.sort());
      for (const row of rows) {
        expect(JSON.parse(row.metadataJson)).toMatchObject({
          evidence: {
            file: row.filePath,
            line: row.startLine,
          },
        });
      }
      expect(
        database.prepare("SELECT count(*) FROM edges WHERE edge_type = 'HANDLES'").pluck().get(),
      ).toBe(4);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             WHERE edge_type = 'REFERENCES'
               AND source_node_id IN (SELECT id FROM nodes WHERE kind = 'database_model')`,
          )
          .pluck()
          .get(),
      ).toBeGreaterThanOrEqual(4);

      const persisted = JSON.stringify(
        database
          .prepare(
            `SELECT name, qualified_name, signature, metadata_json
             FROM nodes WHERE kind IN ('api_route', 'database_model')
             UNION ALL
             SELECT edge_type, source_type, NULL, metadata_json
             FROM edges WHERE source_type IN ('framework', 'schema')`,
          )
          .all(),
      );
      expect(persisted).not.toContain("/users/:userId");
      expect(persisted).not.toContain("/accounts/{account_id}");
      expect(persisted).not.toContain("atlas_users");
      expect(persisted).not.toContain("atlas_posts");
    } finally {
      database.close();
    }
  });

  it("updates framework nodes incrementally and removes obsolete routes", async () => {
    const repository = await createFrameworkRepository();
    await initializeRepository(repository.root);
    const routesPath = path.join(repository.root, "src", "routes.ts");
    const routes = await readFile(routesPath, "utf8");
    await writeFile(
      routesPath,
      routes.replace('app.get("/users/:userId", getUser);', 'app.patch("/users/:userId", getUser);'),
      "utf8",
    );
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({ modifiedFiles: 1, fullRebuild: false, apiRoutes: 4 });

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const methods = database
        .prepare(
          `SELECT json_extract(metadata_json, '$.http_method') AS method
           FROM nodes WHERE kind = 'api_route' AND file_path = 'src/routes.ts'
           ORDER BY method`,
        )
        .all()
        .map((row) => (row as { method: string }).method);
      expect(methods).toEqual(["PATCH", "POST"]);
    } finally {
      database.close();
    }
  });

  it("removes framework semantics when optional analysis is disabled", async () => {
    const repository = await createFrameworkRepository();
    await initializeRepository(repository.root);
    const configPath = workspacePaths(repository.root).config;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      analysis: { frameworks: boolean };
    };
    config.analysis.frameworks = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      fullRebuild: true,
      apiRoutes: 0,
      databaseModels: 0,
      frameworks: [],
    });
  });
});
