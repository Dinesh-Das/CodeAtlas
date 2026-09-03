import { rm } from "node:fs/promises";
import path from "node:path";
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

async function initializedRepository(files: Readonly<Record<string, string>>): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  for (const [filePath, content] of Object.entries(files)) await repository.write(filePath, content);
  await repository.git("add", ".");
  await repository.git("commit", "-m", "semantic invalidation fixture");
  await initializeRepository(repository.root);
  return repository;
}

function timestamps(repository: TestRepository, pathPattern: string): string[] {
  const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
  try {
    return (
      database
        .prepare(
          `SELECT updated_at FROM nodes
           WHERE file_path LIKE ?
           UNION ALL
           SELECT updated_at FROM edges
           WHERE file_path LIKE ?
             AND edge_type NOT IN ('BELONGS_TO_FEATURE', 'BELONGS_TO_DOMAIN')
           ORDER BY updated_at`,
        )
        .all(pathPattern, pathPattern) as Array<{ updated_at: string }>
    ).map((row) => row.updated_at);
  } finally {
    database.close();
  }
}

interface NormalizedEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  source_type: string;
  provenance_category: string;
  confidence: number;
  file_path: string | null;
  line: number | null;
  metadata_json: string;
  owner_kind: string;
}

function normalizedEdges(repository: TestRepository): NormalizedEdge[] {
  const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
  try {
    return database
      .prepare(
        `SELECT id, source_node_id, target_node_id, edge_type, source_type,
                provenance_category, confidence, file_path, line, metadata_json, owner_kind
         FROM edges
         ORDER BY id`,
      )
      .all() as NormalizedEdge[];
  } finally {
    database.close();
  }
}

describe("semantic-delta invalidation", () => {
  it("keeps the exact graph deterministic across harmless edits and line shifts", async () => {
    const app = [
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
    ].join("\n");
    const auth = [
      "export async function handleAuth(): Promise<void> {",
      "  return;",
      "}",
      "",
    ].join("\n");
    const repository = await initializedRepository({
      "api/auth.ts": auth,
      "api/routes.ts": [
        'import type { FastifyPluginCallback } from "fastify";',
        "export async function deleteResetModule(): Promise<void> { return; }",
        "export const protectedRoutes: FastifyPluginCallback = (fastify, _options, done) => {",
        '  fastify.delete("/account/reset-module", deleteResetModule);',
        "  done();",
        "};",
        "",
      ].join("\n"),
      "api/app.ts": app,
    });
    const baseline = normalizedEdges(repository);
    expect([...new Set(baseline.map((edge) => edge.owner_kind))]).toEqual(
      expect.arrayContaining(["extracted", "resolved"]),
    );
    expect(baseline.some((edge) => edge.owner_kind === "architecture_projection")).toBe(true);
    expect(baseline.some((edge) => edge.owner_kind === "framework_projection")).toBe(true);
    expect(baseline.some((edge) => edge.owner_kind === "resolved")).toBe(true);

    await repository.write("api/app.ts", `${app}// harmless comment\n`);
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 0,
      work: { architectureFiles: 0 },
    });
    await repository.write("api/app.ts", app);
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 0,
      work: { architectureFiles: 0 },
    });
    expect(normalizedEdges(repository)).toEqual(baseline);

    await repository.write("api/auth.ts", `${"// shifted evidence\n".repeat(5)}${auth}`);
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 0,
      semanticChanges: { content_only: 1 },
      work: { dependentFilesInvalidated: 0, architectureFiles: 0 },
    });
    const shiftedIncremental = normalizedEdges(repository);
    const shiftedMemberships = shiftedIncremental.filter(
      (edge) =>
        edge.owner_kind === "architecture_projection" && edge.file_path === "api/auth.ts",
    );
    expect(shiftedMemberships.length).toBeGreaterThan(0);
    expect(shiftedMemberships.some((edge) => (edge.line ?? 0) > 5)).toBe(true);

    await indexRepository(repository.root, true);
    expect(normalizedEdges(repository)).toEqual(shiftedIncremental);
  }, 30_000);

  it("keeps comment and formatting edits O(changed facts) on a high-fan-out module", async () => {
    const files: Record<string, string> = {
      "src/central.ts": "export function central(value: number): number { return value * 2; }\n",
    };
    for (let index = 0; index < 250; index += 1) {
      files[`src/consumer-${index}.ts`] =
        `import { central } from "./central.js";\nexport const value${index} = central(${index});\n`;
    }
    const repository = await initializedRepository(files);
    const beforeDependents = timestamps(repository, "src/consumer-%");
    const beforeDatabase = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    const beforeGenerations = beforeDatabase
      .prepare(
        `SELECT key, value FROM repository_state
         WHERE key IN ('structural_generation', 'semantic_generation', 'search_generation', 'architecture_generation')
         ORDER BY key`,
      )
      .all();
    beforeDatabase.close();

    await repository.write(
      "src/central.ts",
      "export function central(value: number): number { return value * 2; }\n// harmless comment\n",
    );
    const comment = await indexRepository(repository.root);
    expect(comment).toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 0,
      semanticChanges: { content_only: 1 },
      work: {
        filesRead: 1,
        filesParsed: 1,
        filesSemanticallyAnalyzed: 0,
        dependentFilesInvalidated: 0,
        candidateCount: 0,
        resolvedEdgeCount: 0,
        architectureFiles: 0,
      },
    });
    expect(timestamps(repository, "src/consumer-%")).toEqual(beforeDependents);
    expect(comment.work.ftsMutations).toBeLessThanOrEqual(1);
    expect(comment.phaseMetrics.find((metric) => metric.phase === "git_history_analysis"))
      .toMatchObject({ itemsProcessed: 0 });

    await repository.write(
      "src/central.ts",
      "export   function central ( value: number ) : number {\n  return value * 2;\n}\n// harmless comment\n",
    );
    const formatting = await indexRepository(repository.root);
    expect(formatting).toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 0,
      semanticChanges: { content_only: 1 },
      work: { filesParsed: 1, candidateCount: 0, architectureFiles: 0 },
    });
    const afterDatabase = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      expect(
        afterDatabase
          .prepare(
            `SELECT key, value FROM repository_state
             WHERE key IN ('structural_generation', 'semantic_generation', 'search_generation', 'architecture_generation')
             ORDER BY key`,
          )
          .all(),
      ).toEqual(beforeGenerations);
    } finally {
      afterDatabase.close();
    }
  }, 60_000);

  it("keeps an implementation-only body change local", async () => {
    const repository = await initializedRepository({
      "src/service.ts": "export function calculate(value: number): number { return value * 2; }\n",
      "src/consumer.ts":
        'import { calculate } from "./service.js";\nexport const result = calculate(2);\n',
    });
    await repository.write(
      "src/service.ts",
      "export function calculate(value: number): number { return value * 3; }\n",
    );
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 0,
      semanticChanges: { implementation_only: 1 },
      work: { filesParsed: 1, candidateCount: 0, resolvedEdgeCount: 0, architectureFiles: 0 },
    });
  });

  it("re-resolves only relationships originating in a file whose import changes", async () => {
    const repository = await initializedRepository({
      "src/foo.ts": "export function foo(): number { return 1; }\n",
      "src/bar.ts": "export function bar(): number { return 2; }\n",
      "src/consumer.ts":
        'import { foo } from "./foo.js";\nexport function consume(): number { return foo(); }\n',
      "src/unrelated.ts": "export const unrelated = true;\n",
    });
    const beforeUnrelated = timestamps(repository, "src/unrelated.ts");
    await repository.write(
      "src/consumer.ts",
      'import { bar } from "./bar.js";\nexport function consume(): number { return bar(); }\n',
    );
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 0,
      semanticChanges: { outgoing_change: 1 },
      work: { filesParsed: 1, dependentFilesInvalidated: 0 },
    });
    expect(result.work.referencesRewritten).toBeGreaterThan(0);
    expect(timestamps(repository, "src/unrelated.ts")).toEqual(beforeUnrelated);
  });

  it("invalidates exact consumers for a public signature change and export rename", async () => {
    const files: Record<string, string> = {
      "src/service.ts":
        "export function operation(value: number): number { return value; }\nexport function stable(): boolean { return true; }\n",
      "src/unrelated.ts":
        'import { stable } from "./service.js";\nexport const unrelated = stable();\n',
    };
    for (let index = 0; index < 4; index += 1) {
      files[`src/consumer-${index}.ts`] =
        `import { operation } from "./service.js";\nexport const value${index} = operation(${index});\n`;
    }
    const repository = await initializedRepository(files);
    await repository.write(
      "src/service.ts",
      "export function operation(value: string): string { return value; }\nexport function stable(): boolean { return true; }\n",
    );
    const signature = await indexRepository(repository.root);
    expect(signature).toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 4,
      semanticChanges: { public_contract_change: 1 },
      work: { filesParsed: 1, dependentFilesInvalidated: 4 },
    });

    const unrelatedBefore = timestamps(repository, "src/unrelated.ts");
    await repository.write(
      "src/service.ts",
      "export function replacement(value: string): string { return value; }\nexport function stable(): boolean { return true; }\n",
    );
    const rename = await indexRepository(repository.root);
    expect(rename).toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 4,
      semanticChanges: { public_contract_change: 1 },
    });
    expect(timestamps(repository, "src/unrelated.ts")).toEqual(unrelatedBefore);
  });

  it("invalidates consumers when an exported function's inferred return type changes", async () => {
    const repository = await initializedRepository({
      "src/value.ts": "export function value() { return 1; }\n",
      "src/consumer.ts":
        'import { value } from "./value.js";\nexport const formatted = value().toFixed();\n',
    });
    await repository.write("src/value.ts", 'export function value() { return "1"; }\n');
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 1,
      semanticChanges: { public_contract_change: 1 },
      work: { dependentFilesInvalidated: 1 },
    });
  });

  it("invalidates consumers when an exported object's inferred property type changes", async () => {
    const repository = await initializedRepository({
      "src/config.ts": "export const config = { enabled: true };\n",
      "src/consumer.ts":
        'import { config } from "./config.js";\nexport const enabled: boolean = config.enabled;\n',
    });
    await repository.write(
      "src/config.ts",
      'export const config = { enabled: "yes" };\n',
    );
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 1,
      semanticChanges: { public_contract_change: 1 },
    });
  });

  it("uses JSDoc types in JavaScript public API fingerprints", async () => {
    const repository = await initializedRepository({
      "src/value.js": "/** @returns {number} */\nexport function value() { return 1; }\n",
      "src/consumer.js":
        'import { value } from "./value.js";\nexport const formatted = value().toFixed();\n',
    });
    await repository.write(
      "src/value.js",
      "/** @returns {string} */\nexport function value() { return 1; }\n",
    );
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 1,
      invalidatedFiles: 1,
      semanticChanges: { public_contract_change: 1 },
    });
  });

  it("treats TypeScript project configuration as an explicit broad resolution change", async () => {
    const repository = await initializedRepository({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
          paths: { "@app/*": ["src/*"] },
        },
      }),
      "src/service.ts": "export const service = true;\n",
      "src/consumer.ts": 'import { service } from "@app/service";\nexport const value = service;\n',
    });
    await repository.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
          paths: { "@app/*": ["lib/*"] },
        },
      }),
    );
    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      changedFiles: 1,
      semanticChanges: { module_resolution_change: 1 },
      work: { filesParsed: 0 },
    });
    expect(result.invalidatedFiles).toBe(2);
    expect(result.work.referencesRewritten).toBeGreaterThan(0);
  });

  it("tracks new and subsequently deleted untracked leaf files through the manifest fast path", async () => {
    const repository = await initializedRepository({
      "src/root.ts": "export const root = true;\n",
    });
    await repository.write("src/leaf.ts", "export const leaf = true;\n");
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 1,
      addedFiles: 1,
      invalidatedFiles: 0,
    });
    await rm(path.join(repository.root, "src", "leaf.ts"));
    await expect(indexRepository(repository.root)).resolves.toMatchObject({
      changedFiles: 0,
      deletedFiles: 1,
      invalidatedFiles: 0,
    });
  });
});
