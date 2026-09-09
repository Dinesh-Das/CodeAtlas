import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { getLanguageAdapter } from "../../src/parser/registry.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("additional built-in languages", () => {
  it("turns runtime observations into evidence-backed relationships", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/runtime.ts", [
      "export function dispatch(): void {}",
      "export function registeredHandler(): void {}",
      "",
    ].join("\n"));
    await repository.write("codeatlas.runtime.json", JSON.stringify({
      version: 1,
      relationships: [{
        source: "dispatch",
        target: "registeredHandler",
        type: "CALLS",
        observation: "trace",
        count: 12,
        confidence: 1,
      }],
    }, null, 2));
    await repository.git("add", ".");
    await repository.git("commit", "-m", "runtime evidence fixture");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const observed = database
        .prepare(
          `SELECT edges.edge_type AS edgeType, edges.source_type AS sourceType,
                  edges.provenance_category AS provenance,
                  source.name AS source, target.name AS target,
                  json_extract(edges.metadata_json, '$.evidence_class') AS evidenceClass,
                  json_extract(edges.metadata_json, '$.observation_count') AS observationCount
           FROM edges
           JOIN nodes source ON source.id = edges.source_node_id
           JOIN nodes target ON target.id = edges.target_node_id
           WHERE json_extract(edges.metadata_json, '$.evidence_class') = 'runtime_observation'`,
        )
        .get();
      expect(observed).toEqual({
        edgeType: "CALLS",
        sourceType: "config",
        provenance: "verified",
        source: "dispatch",
        target: "registeredHandler",
        evidenceClass: "runtime_observation",
        observationCount: 12,
      });
    } finally {
      database.close();
    }
  }, 60_000);

  it("indexes Go, Java, and Rust symbols and resolves repository-local relationships", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("go.mod", "module example.com/codeatlas\n\ngo 1.24\n");
    await repository.write("store/store.go", [
      "package store",
      "type Repository struct {}",
      "func (repository *Repository) Save() error { return nil }",
      "",
    ].join("\n"));
    await repository.write("service/service.go", [
      "package service",
      'import "example.com/codeatlas/store"',
      "type Worker struct { repository *store.Repository }",
      "func (worker *Worker) Run() error { return worker.repository.Save() }",
      "",
    ].join("\n"));
    await repository.write("src/main/java/io/codeatlas/store/Repository.java", [
      "package io.codeatlas.store;",
      "public class Repository { public void save() {} }",
      "",
    ].join("\n"));
    await repository.write("src/main/java/io/codeatlas/service/Service.java", [
      "package io.codeatlas.service;",
      "import io.codeatlas.store.Repository;",
      "public class Service {",
      "  private final Repository repository;",
      "  public Service(Repository repository) { this.repository = repository; }",
      "  public void run() { repository.save(); }",
      "}",
      "",
    ].join("\n"));
    await repository.write("src/store.rs", [
      "pub struct Repository;",
      "impl Repository { pub fn save(&self) {} }",
      "",
    ].join("\n"));
    await repository.write("src/service.rs", [
      "use crate::store::Repository;",
      "pub struct Service { repository: Repository }",
      "impl Service { pub fn run(&self) { self.repository.save(); } }",
      "",
    ].join("\n"));
    await repository.git("add", ".");
    await repository.git("commit", "-m", "multi-language fixture");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const languages = database
        .prepare(
          `SELECT language, count(*) AS files
           FROM files WHERE language IN ('go', 'java', 'rust')
           GROUP BY language ORDER BY language`,
        )
        .all();
      expect(languages).toEqual([
        { language: "go", files: 2 },
        { language: "java", files: 2 },
        { language: "rust", files: 2 },
      ]);
      const symbols = database
        .prepare(
          `SELECT DISTINCT language, name FROM nodes
           WHERE language IN ('go', 'java', 'rust') AND name IN ('Service', 'Worker', 'Run', 'run')
           ORDER BY language, name`,
        )
        .all();
      expect(symbols).toEqual(expect.arrayContaining([
        { language: "go", name: "Worker" },
        { language: "go", name: "Run" },
        { language: "java", name: "Service" },
        { language: "java", name: "run" },
        { language: "rust", name: "Service" },
        { language: "rust", name: "run" },
      ]));
      const relationships = database
        .prepare(
          `SELECT source.language AS language, edges.edge_type AS edgeType
           FROM edges JOIN nodes source ON source.id = edges.source_node_id
           WHERE source.language IN ('go', 'java', 'rust')
             AND edges.edge_type IN ('IMPORTS', 'CALLS')`,
        )
        .all() as Array<{ language: string; edgeType: string }>;
      for (const language of ["go", "java", "rust"]) {
        expect(relationships).toContainEqual({ language, edgeType: "IMPORTS" });
        expect(relationships).toContainEqual({ language, edgeType: "CALLS" });
      }
    } finally {
      database.close();
    }
  }, 60_000);

  it("marks reflective, registered, and generated behavior as dynamic", () => {
    const cases = [
      {
        language: "go",
        file: "generated/wire.go",
        source: "// Code generated by wire. DO NOT EDIT.\npackage generated\nfunc Build() { reflect.ValueOf(Build).Call(nil) }\n",
      },
      {
        language: "java",
        file: "target/generated-sources/Loader.java",
        source: "class Loader { void load() throws Exception { Class.forName(\"hidden.Type\"); } }\n",
      },
      {
        language: "rust",
        file: "generated/bindings.rs",
        source: "// automatically generated; do not edit\npub fn load() { include!(\"bindings.inc\"); }\n",
      },
    ] as const;

    for (const item of cases) {
      const adapter = getLanguageAdapter(item.language)!;
      const parsed = adapter.parseFile({
        repositoryId: "dynamic-fixture",
        repositoryRoot: ".",
        relativeFilePath: item.file,
        language: item.language,
        content: item.source,
        contentHash: "fixture-hash",
      });
      expect(parsed.unresolvedReferences).toContainEqual(expect.objectContaining({
        kind: "generated",
        provenance: "dynamic",
      }));
      expect(parsed.unresolvedReferences).toContainEqual(expect.objectContaining({
        kind: "reflection",
        provenance: "dynamic",
      }));
    }
  });
});
