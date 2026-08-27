import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("relationship resolution", () => {
  it("matches the deterministic evidence-bearing call graph snapshot", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const fixtureRoot = path.resolve("tests", "fixtures", "relationships", "typescript");
    for (const filename of [
      "base.ts",
      "consumer.ts",
      "ambiguous-a.ts",
      "ambiguous-b.ts",
      "ambiguous-bridge.ts",
      "ambiguous-consumer.ts",
      "common-base.cjs",
      "common-consumer.cjs",
    ]) {
      await repository.write(
        `src/${filename}`,
        await readFile(path.join(fixtureRoot, filename), "utf8"),
      );
    }
    await repository.git("add", ".");
    await repository.git("commit", "-m", "relationship fixture");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const relationships = database
        .prepare(
          `SELECT edges.edge_type AS edgeType,
                  source.qualified_name AS sourceName,
                  target.qualified_name AS targetName,
                  edges.confidence,
                  edges.source_type AS sourceType,
                  edges.file_path AS filePath,
                  edges.line
           FROM edges
           JOIN nodes source ON source.id = edges.source_node_id
           JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type IN ('IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'REFERENCES')
           ORDER BY edges.file_path, edges.line, edges.edge_type, target.file_path, target.qualified_name`,
        )
        .all() as Array<{
          edgeType: string;
          sourceName: string;
          targetName: string;
          confidence: number;
          sourceType: string;
          filePath: string;
          line: number;
        }>;
      const compact = relationships.map(
        (edge) =>
          `${edge.edgeType}|${edge.sourceName}|${edge.targetName}|${edge.confidence}|${edge.sourceType}|${edge.filePath}:${edge.line}`,
      );
      const expected = JSON.parse(
        await readFile(path.join(fixtureRoot, "expected.json"), "utf8"),
      ) as string[];
      expect(compact).toEqual(expected);

      const ambiguity = database
        .prepare(
          `SELECT reason, reference_name AS referenceName, candidate_node_ids_json AS candidates
           FROM resolution_issues
           WHERE reason = 'multi_candidate'`,
        )
        .get() as { reason: string; referenceName: string; candidates: string };
      expect(ambiguity).toMatchObject({ reason: "multi_candidate", referenceName: "duplicate" });
      expect(JSON.parse(ambiguity.candidates)).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("resolves Python aliases, calls, inheritance, and references", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const fixtureRoot = path.resolve("tests", "fixtures", "relationships", "python");
    for (const filename of ["base.py", "consumer.py"]) {
      await repository.write(
        `pkg/${filename}`,
        await readFile(path.join(fixtureRoot, filename), "utf8"),
      );
    }
    await repository.git("add", ".");
    await repository.git("commit", "-m", "python relationship fixture");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const rows = database
        .prepare(
          `SELECT edges.edge_type AS edgeType,
                  source.qualified_name AS sourceName,
                  target.qualified_name AS targetName,
                  edges.confidence,
                  edges.source_type AS sourceType,
                  edges.file_path AS filePath,
                  edges.line
           FROM edges
           JOIN nodes source ON source.id = edges.source_node_id
           JOIN nodes target ON target.id = edges.target_node_id
           WHERE edges.edge_type IN ('IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'REFERENCES')
           ORDER BY edges.file_path, edges.line, edges.edge_type, target.qualified_name`,
        )
        .all() as Array<{
          edgeType: string;
          sourceName: string;
          targetName: string;
          confidence: number;
          sourceType: string;
          filePath: string;
          line: number;
        }>;
      const compact = rows.map(
        (edge) =>
          `${edge.edgeType}|${edge.sourceName}|${edge.targetName}|${edge.confidence}|${edge.sourceType}|${edge.filePath}:${edge.line}`,
      );
      const expected = JSON.parse(
        await readFile(path.join(fixtureRoot, "expected.json"), "utf8"),
      ) as string[];
      expect(compact).toEqual(expected);
    } finally {
      database.close();
    }
  });

  it("never stores unresolved module specifier values", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/index.ts", 'import value from "private-module-name";\nvalue();\n');
    await repository.git("add", ".");
    await repository.git("commit", "-m", "unresolved import");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const issue = database
        .prepare(
          `SELECT reference_name AS referenceName, reference_hash AS referenceHash
           FROM resolution_issues WHERE reference_kind = 'import'`,
        )
        .get() as { referenceName: string | null; referenceHash: string };
      expect(issue.referenceName).toBeNull();
      expect(issue.referenceHash).toMatch(/^[a-f0-9]{64}$/u);
      const stored = JSON.stringify(
        database
          .prepare(
            `SELECT reference_name, metadata_json, candidate_node_ids_json
             FROM resolution_issues`,
          )
          .all(),
      );
      expect(stored).not.toContain("private-module-name");
    } finally {
      database.close();
    }
  });
});
