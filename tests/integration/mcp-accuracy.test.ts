import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { getNodePacket, tracePacket } from "../../src/mcp/graph-tools.js";
import { ensureFreshIndex } from "../../src/mcp/freshness.js";
import { sourcePacket } from "../../src/mcp/repository-tools.js";
import { answerPacketSchema } from "../../src/mcp/schemas.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("Phase 7 MCP accuracy", () => {
  it("reads current-working-tree source and enforces the configured line limit", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/reporting/elaborate.ts",
      [
        "// source fixture",
        "export function elaborate(): boolean {",
        "  const first = true;",
        "  const second = false;",
        "  return first && !second;",
        "}",
        "",
      ].join("\n"),
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "source accuracy fixture");
    await initializeRepository(repository.root);
    await repository.write(
      ".codeatlas/config.json",
      `${JSON.stringify(
        {
          ...DEFAULT_CONFIG,
          limits: { ...DEFAULT_CONFIG.limits, maxSourceSnippetLines: 2 },
        },
        null,
        2,
      )}\n`,
    );

    let context = await ensureFreshIndex(repository.root);
    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    const nodeId = database
      .prepare("SELECT id FROM nodes WHERE qualified_name = 'elaborate'")
      .pluck()
      .get() as string;
    database.close();

    const initial = answerPacketSchema.parse(await sourcePacket(context, { node_id: nodeId }));
    expect(initial.source_snippets).toHaveLength(1);
    expect(initial.source_snippets[0]).toMatchObject({
      file: "src/reporting/elaborate.ts",
      start_line: 2,
      end_line: 3,
      trust: "untrusted_repository_content",
    });
    expect(initial.source_snippets[0]?.content.split("\n")).toHaveLength(2);
    expect(initial.uncertainties).toContainEqual(
      expect.objectContaining({ reason: "insufficient_evidence" }),
    );

    await repository.write(
      "src/reporting/elaborate.ts",
      [
        "// a new current-tree line",
        "// another current-tree line",
        "// source fixture",
        "export function elaborate(): boolean {",
        "  const current = true;",
        "  return current;",
        "}",
        "",
      ].join("\n"),
    );
    context = await ensureFreshIndex(repository.root);
    const refreshed = answerPacketSchema.parse(await sourcePacket(context, { node_id: nodeId }));
    expect(refreshed.source_snippets[0]).toMatchObject({ start_line: 4, end_line: 5 });
    expect(refreshed.source_snippets[0]?.content).toContain("const current = true");
    expect(refreshed.source_snippets[0]?.content).not.toContain("const first = true");
  });

  it("surfaces ambiguous resolution candidates instead of presenting a guessed call", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/a.ts", "export function duplicate(): void {}\n");
    await repository.write("src/b.ts", "export function duplicate(): void {}\n");
    await repository.write("src/bridge.ts", 'import "./b.js";\n');
    await repository.write(
      "src/consumer.ts",
      [
        'import "./a.js";',
        'import "./bridge.js";',
        "export function invoke(): void {",
        "  duplicate();",
        "}",
        "",
      ].join("\n"),
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "ambiguous accuracy fixture");
    await initializeRepository(repository.root);

    const context = await ensureFreshIndex(repository.root);
    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    const invokeId = database
      .prepare("SELECT id FROM nodes WHERE qualified_name = 'invoke'")
      .pluck()
      .get() as string;
    database.close();

    const response = answerPacketSchema.parse(getNodePacket(context, { node_id: invokeId }));
    const ambiguousCalls = response.relationships.filter(
      (relationship) => relationship.edge_type === "CALLS",
    );
    expect(ambiguousCalls).toHaveLength(2);
    expect(ambiguousCalls.every((relationship) => relationship.confidence < 1)).toBe(true);
    expect(ambiguousCalls.every((relationship) => relationship.source_type === "heuristic")).toBe(true);
    expect(response.uncertainties).toContainEqual(
      expect.objectContaining({ reason: "multi_candidate", candidates: expect.any(Array) }),
    );
    expect(
      response.uncertainties.find((uncertainty) => uncertainty.reason === "multi_candidate")
        ?.candidates,
    ).toHaveLength(2);
    for (const relationship of ambiguousCalls) {
      expect(relationship.evidence).toMatchObject({ file: "src/consumer.ts", line: 4 });
    }
  });

  it("bounds execution paths using the configured path limit", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/flow.ts",
      [
        "export function first(): void {}",
        "export function second(): void {}",
        "export function third(): void {}",
        "export function start(): void {",
        "  first();",
        "  second();",
        "  third();",
        "}",
        "",
      ].join("\n"),
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "bounded trace fixture");
    await initializeRepository(repository.root);
    await repository.write(
      ".codeatlas/config.json",
      `${JSON.stringify(
        {
          ...DEFAULT_CONFIG,
          limits: { ...DEFAULT_CONFIG.limits, maxExecutionPaths: 2 },
        },
        null,
        2,
      )}\n`,
    );

    const context = await ensureFreshIndex(repository.root);
    const response = answerPacketSchema.parse(
      tracePacket(context, { start: "start", max_depth: 2, limit: 50 }),
    );
    expect(response.relationships).toHaveLength(2);
    expect(response.uncertainties).toContainEqual(
      expect.objectContaining({ reason: "insufficient_evidence" }),
    );
  });
});
