import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { indexRepository } from "../../src/cli/index-command.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { runIndex } from "../../src/indexer/indexer.js";
import { openDatabase } from "../../src/storage/database.js";
import { searchPacket, tracePacket } from "../../src/mcp/graph-tools.js";
import { ensureFreshIndex } from "../../src/mcp/freshness.js";
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
    ["api/fastify-routes.ts", "fastify/routes.ts"],
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

function normalizedGraph(repositoryRoot: string): { nodes: unknown[]; edges: unknown[] } {
  const database = openDatabase(workspacePaths(repositoryRoot).database, { readonly: true });
  try {
    return {
      nodes: database
        .prepare(
          `SELECT id, kind, name, qualified_name, file_path, language,
                  start_line, start_column, end_line, end_column, signature,
                  visibility, content_hash, source_type, provenance_category,
                  confidence, metadata_json
           FROM nodes
           ORDER BY id`,
        )
        .all(),
      edges: database
        .prepare(
          `SELECT id, source_node_id, target_node_id, edge_type, source_type,
                  provenance_category, confidence, file_path, line, metadata_json
           FROM edges
           ORDER BY id`,
        )
        .all(),
    };
  } finally {
    database.close();
  }
}

describe("Phase 5 framework adapters", () => {
  it("produces an equivalent normalized graph across full rebuilds", async () => {
    const repository = await createFrameworkRepository();
    await initializeRepository(repository.root);
    const initial = normalizedGraph(repository.root);

    await runIndex({ startPath: repository.root, full: true });
    expect(normalizedGraph(repository.root)).toEqual(initial);

    await runIndex({ startPath: repository.root, full: true });
    expect(normalizedGraph(repository.root)).toEqual(initial);
  });

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
      ).toBe(6);
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
    expect(result).toMatchObject({ modifiedFiles: 1, fullRebuild: false, apiRoutes: 6 });

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

  it("materializes verified Fastify auth composition and Prisma model operations", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "api/prisma/schema.prisma",
      [
        "model user {",
        "  id String @id",
        "  completedChallenges String[]",
        "}",
        "",
      ].join("\n"),
    );
    await repository.write(
      "api/auth.ts",
      [
        "export async function handleAuth(): Promise<void> {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    );
    await repository.write(
      "api/routes.ts",
      [
        'import type { FastifyPluginCallback } from "fastify";',
        'import { PrismaClient } from "@prisma/client";',
        "const prisma = new PrismaClient();",
        "export async function deleteResetModule(): Promise<void> {",
        "  await prisma.user.findUniqueOrThrow({ where: { id: 'user' } });",
        "  await prisma.user.update({ where: { id: 'user' }, data: {} });",
        "}",
        "export const protectedRoutes: FastifyPluginCallback = (fastify, _options, done) => {",
        '  fastify.delete("/account/reset-module", deleteResetModule);',
        "  done();",
        "};",
        "",
      ].join("\n"),
    );
    await repository.write(
      "api/app.ts",
      [
        'import Fastify from "fastify";',
        'import { handleAuth } from "./auth.js";',
        'import { protectedRoutes } from "./routes.js";',
        "const fastify = Fastify();",
        'fastify.decorate("authorize", handleAuth);',
        "fastify.register(protectedRoutes, {",
        '  prefix: "/api",',
        "  onRequest: fastify.authorize,",
        "});",
        "",
      ].join("\n"),
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "Fastify and Prisma composition");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    let routeId: string;
    try {
      routeId = database
        .prepare("SELECT id FROM nodes WHERE kind = 'api_route' AND name = 'DELETE deleteResetModule'")
        .pluck()
        .get() as string;
      const edges = database
        .prepare(
          `SELECT edges.edge_type AS edgeType, source.name AS sourceName,
                  target.name AS targetName, edges.source_type AS sourceType,
                  edges.provenance_category AS provenance, edges.confidence
           FROM edges
           JOIN nodes source ON source.id = edges.source_node_id
           JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type IN (
             'HANDLES', 'IMPLEMENTED_BY', 'DECORATES', 'MOUNTS', 'APPLIES_HOOK',
             'PROTECTED_BY', 'MAY_CONTINUE_TO', 'ROUTE_PREFIX', 'QUERIES', 'UPDATES'
           )
           ORDER BY edges.edge_type, source.name, target.name`,
        )
        .all() as Array<{
          edgeType: string;
          sourceName: string;
          targetName: string;
          sourceType: string;
          provenance: string;
          confidence: number;
        }>;
      expect(edges).toContainEqual(
        expect.objectContaining({
          edgeType: "HANDLES",
          sourceName: "DELETE deleteResetModule",
          targetName: "deleteResetModule",
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          edgeType: "IMPLEMENTED_BY",
          sourceName: "authorize",
          targetName: "handleAuth",
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          edgeType: "DECORATES",
          sourceName: "handleAuth",
          targetName: "authorize",
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          edgeType: "MOUNTS",
          sourceName: "register protectedRoutes",
          targetName: "protectedRoutes",
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          edgeType: "APPLIES_HOOK",
          sourceName: "register protectedRoutes",
          targetName: "authorize",
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          edgeType: "PROTECTED_BY",
          sourceName: "DELETE deleteResetModule",
          targetName: "authorize",
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          edgeType: "MAY_CONTINUE_TO",
          sourceName: "handleAuth",
          targetName: "DELETE deleteResetModule",
        }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({
          edgeType: "ROUTE_PREFIX",
          sourceName: "register protectedRoutes",
          targetName: "DELETE deleteResetModule",
        }),
      );
      for (const edgeType of ["QUERIES", "UPDATES"]) {
        expect(edges).toContainEqual(
          expect.objectContaining({
            edgeType,
            sourceName: "deleteResetModule",
            targetName: "user",
            sourceType: "framework",
            provenance: "verified",
            confidence: 1,
          }),
        );
      }
      expect(
        database
          .prepare(
            `SELECT count(*) FROM resolution_issues
             WHERE reference_name IN ('prisma.user.findUniqueOrThrow', 'prisma.user.update')`,
          )
          .pluck()
          .get(),
      ).toBe(0);
      const continuationMetadata = database
        .prepare(
          `SELECT metadata_json FROM edges
           WHERE edge_type = 'MAY_CONTINUE_TO'
             AND target_node_id = ?`,
        )
        .pluck()
        .get(routeId) as string;
      expect(JSON.parse(continuationMetadata)).toMatchObject({
        conditional: true,
        condition: "hook_completes_without_terminating_the_request",
      });
    } finally {
      database.close();
    }

    const context = await ensureFreshIndex(repository.root);
    const search = searchPacket(context, {
      query: "DELETE /account/reset-module",
      limit: 10,
    });
    expect(search.facts).toContainEqual(
      expect.objectContaining({ statement: expect.stringContaining("DELETE /account/reset-module") }),
    );
    const prefixedSearch = searchPacket(context, {
      query: "DELETE /api/account/reset-module",
      limit: 10,
    });
    expect(prefixedSearch.facts).toContainEqual(
      expect.objectContaining({
        statement: expect.stringContaining("DELETE /api/account/reset-module"),
      }),
    );
    expect(prefixedSearch.relationships).toContainEqual(
      expect.objectContaining({ edge_type: "ROUTE_PREFIX" }),
    );
    const trace = tracePacket(context, {
      start: routeId!,
      max_depth: 5,
      limit: 50,
    });
    expect(trace.relationships.map((relationship) => relationship.edge_type)).toEqual(
      expect.arrayContaining(["HANDLES", "PROTECTED_BY", "IMPLEMENTED_BY", "QUERIES", "UPDATES"]),
    );
    expect(trace.relationships.every((relationship) =>
      relationship.source !== undefined && relationship.target !== undefined
    )).toBe(true);
    expect(trace.source_snippets.length).toBeGreaterThan(0);
  });

  it("understands nested Fastify plugin parameters, preValidation, and inline handlers", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "api/app.ts",
      [
        'import Fastify from "fastify";',
        "async function validate(): Promise<void> { return; }",
        "const fastify = Fastify();",
        "fastify.register(async function(instance) {",
        '  instance.addHook("preValidation", validate);',
        "  instance.register(async function(child) {",
        '    child.get("/orders", async (_request, _reply) => ({ ok: true }));',
        '  }, { prefix: "/v1" });',
        '}, { prefix: "/api" });',
        "",
      ].join("\n"),
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "nested Fastify plugins");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const routeId = database
        .prepare("SELECT id FROM nodes WHERE kind = 'api_route' AND name = 'GET anonymous'")
        .pluck()
        .get() as string;
      expect(routeId).toBeTypeOf("string");
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             WHERE source_node_id = ? AND edge_type = 'HANDLES'
               AND target_node_id IN (
                 SELECT id FROM nodes
                 WHERE json_extract(metadata_json, '$.fastify_entity') = 'inline_route_handler'
               )`,
          )
          .pluck()
          .get(routeId),
      ).toBe(1);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             WHERE source_node_id = ? AND edge_type = 'PROTECTED_BY'
               AND target_node_id IN (SELECT id FROM nodes WHERE name = 'validate')`,
          )
          .pluck()
          .get(routeId),
      ).toBe(1);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             WHERE target_node_id = ? AND edge_type = 'MAY_CONTINUE_TO'
               AND source_node_id IN (SELECT id FROM nodes WHERE name = 'validate')`,
          )
          .pluck()
          .get(routeId),
      ).toBe(1);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             WHERE target_node_id = ? AND edge_type = 'ROUTE_PREFIX'`,
          )
          .pluck()
          .get(routeId),
      ).toBe(2);
      expect(
        database
          .prepare(
            `SELECT count(*) FROM nodes
             WHERE json_extract(metadata_json, '$.fastify_entity') = 'inline_plugin'`,
          )
          .pluck()
          .get(),
      ).toBe(2);
    } finally {
      database.close();
    }
    const context = await ensureFreshIndex(repository.root);
    const search = searchPacket(context, { query: "GET /api/v1/orders", limit: 10 });
    expect(search.facts).toContainEqual(
      expect.objectContaining({ statement: expect.stringContaining("GET anonymous") }),
    );
  });
});
