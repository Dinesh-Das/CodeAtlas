import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { indexRepository } from "../../src/cli/index-command.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

async function createContractRepository(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await repository.write("src/server.ts", [
    'import express from "express";',
    'import { PrismaClient } from "@prisma/client";',
    "const app = express();",
    "const prisma = new PrismaClient();",
    "export function createUser() { return persistUser(); }",
    "export function persistUser() { return prisma.user.create({ data: { email: process.env.DEFAULT_EMAIL } }); }",
    "export function internalHealth() { return true; }",
    'app.post("/users", createUser);',
    'app.get("/internal", internalHealth);',
    "",
  ].join("\n"));
  await repository.write("prisma/schema.prisma", [
    "model User {",
    "  id Int @id",
    "  email String",
    "}",
    "",
  ].join("\n"));
  await repository.write("openapi.json", JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Accounts API", version: "1.0.0" },
    servers: [{ url: "https://private.example.invalid" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/users": {
        post: {
          operationId: "createUser",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/UserInput" } } } },
          responses: { "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
        },
      },
      "/missing": { get: { operationId: "missingOperation", responses: { "200": { description: "ok" } } } },
    },
    components: {
      schemas: { UserInput: { type: "object" }, User: { type: "object" } },
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
  }, null, 2));
  await repository.write("asyncapi.json", JSON.stringify({
    asyncapi: "2.6.0",
    info: { title: "Account events", version: "1.0.0" },
    servers: { production: { url: "broker.example.invalid", protocol: "kafka" } },
    channels: {
      "user.created": { publish: { message: { $ref: "#/components/messages/UserCreated" } } },
    },
    components: { schemas: { UserCreated: { type: "object" } } },
  }, null, 2));
  await repository.write("docker-compose.yml", [
    "services:",
    "  api:",
    "    image: accounts-api:latest",
    "    environment:",
    "      - DATABASE_URL=postgres://database/accounts",
    "  database:",
    "    image: postgres:17",
    "",
  ].join("\n"));
  await repository.write("k8s/deployment.yaml", [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: accounts-api",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    "        - name: api",
    "          env:",
    "            - name: DATABASE_URL",
    "---",
    "apiVersion: batch/v1",
    "kind: CronJob",
    "metadata:",
    "  name: account-cleanup",
    "",
  ].join("\n"));
  await repository.git("add", ".");
  await repository.git("commit", "-m", "contract fixture");
  return repository;
}

describe("runtime and declared boundary contracts", () => {
  it("links OpenAPI operations to runtime routes and reports exact drift", async () => {
    const repository = await createContractRepository();
    await initializeRepository(repository.root);
    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const kinds = database
        .prepare("SELECT kind, count(*) AS count FROM nodes GROUP BY kind")
        .all() as Array<{ kind: string; count: number }>;
      const counts = new Map(kinds.map((row) => [row.kind, row.count]));
      for (const kind of [
        "api_route", "database_model", "external_actor", "service", "process",
        "http_contract", "contract_schema", "contract_drift", "job", "datastore",
        "environment_variable", "configuration_key", "event", "topic",
      ]) {
        expect(counts.get(kind), `missing first-class ${kind} node`).toBeGreaterThan(0);
      }

      const contractEdges = database
        .prepare("SELECT edge_type FROM edges WHERE edge_type IN ('IMPLEMENTS_CONTRACT', 'ACCEPTS', 'RETURNS', 'PROTECTED_BY', 'PUBLISHES') ORDER BY edge_type")
        .all() as Array<{ edge_type: string }>;
      expect(contractEdges.map((row) => row.edge_type)).toEqual(expect.arrayContaining([
        "IMPLEMENTS_CONTRACT", "ACCEPTS", "RETURNS", "PROTECTED_BY", "PUBLISHES",
      ]));
      expect(contractEdges.filter((row) => row.edge_type === "IMPLEMENTS_CONTRACT")).toHaveLength(1);
      const expectedEdges = new Map([
        ["IMPLEMENTS_CONTRACT", 1],
        ["ACCEPTS", 1],
        ["RETURNS", 1],
        ["PROTECTED_BY", 2],
        ["PUBLISHES", 1],
      ]);
      for (const [edgeType, expectedCount] of expectedEdges) {
        const actualCount = contractEdges.filter((row) => row.edge_type === edgeType).length;
        const truePositives = Math.min(actualCount, expectedCount);
        expect(truePositives / actualCount, `${edgeType} precision`).toBe(1);
        expect(truePositives / expectedCount, `${edgeType} recall`).toBe(1);
      }

      const drift = database
        .prepare("SELECT json_extract(metadata_json, '$.contract_drift') AS kind FROM nodes WHERE kind = 'contract_drift' ORDER BY kind")
        .all() as Array<{ kind: string }>;
      expect(drift.map((row) => row.kind)).toEqual([
        "declared_but_unimplemented",
        "implemented_but_undocumented",
      ]);

      const boundaryEvidence = database
        .prepare(
          `SELECT file_path, start_line, json_extract(metadata_json, '$.evidence.file') AS evidence_file
           FROM nodes
           WHERE kind IN ('api_route', 'http_contract', 'contract_schema', 'event', 'topic', 'service', 'process', 'job', 'datastore')`,
        )
        .all() as Array<{ file_path: string | null; start_line: number | null; evidence_file: string | null }>;
      expect(boundaryEvidence.length).toBeGreaterThan(10);
      expect(boundaryEvidence.every((row) => row.file_path !== null && row.start_line !== null && row.evidence_file === row.file_path)).toBe(true);

      const persisted = JSON.stringify(database.prepare(
        "SELECT name, qualified_name, metadata_json FROM nodes UNION ALL SELECT edge_type, source_type, metadata_json FROM edges",
      ).all());
      expect(persisted).not.toContain("/users");
      expect(persisted).not.toContain("/missing");
      expect(persisted).not.toContain("/internal");
      expect(persisted).not.toContain("private.example.invalid");
      expect(persisted).not.toContain("user.created");
    } finally {
      database.close();
    }
  });

  it("refreshes contract drift after an incremental route change", async () => {
    const repository = await createContractRepository();
    await initializeRepository(repository.root);
    await repository.write("src/server.ts", [
      'import express from "express";',
      "const app = express();",
      "export function createUser() { return true; }",
      "export function missingOperation() { return true; }",
      "export function internalHealth() { return true; }",
      'app.post("/users", createUser);',
      'app.get("/missing", missingOperation);',
      'app.get("/internal", internalHealth);',
      "",
    ].join("\n"));
    await indexRepository(repository.root);
    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      expect(database.prepare("SELECT count(*) FROM edges WHERE edge_type = 'IMPLEMENTS_CONTRACT'").pluck().get()).toBe(2);
      expect(database
        .prepare("SELECT count(*) FROM nodes WHERE kind = 'contract_drift' AND json_extract(metadata_json, '$.contract_drift') = 'declared_but_unimplemented'")
        .pluck().get()).toBe(0);
      expect(database
        .prepare("SELECT count(*) FROM nodes WHERE kind = 'contract_drift' AND json_extract(metadata_json, '$.contract_drift') = 'implemented_but_undocumented'")
        .pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });
});
