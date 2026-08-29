import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { workspacePaths } from "../../src/core/workspace.js";
import {
  dependenciesPacket,
  explainFeaturePacket,
  getNodePacket,
  tracePacket,
} from "../../src/mcp/graph-tools.js";
import { ensureFreshIndex } from "../../src/mcp/freshness.js";
import { sourcePacket, statusPacket } from "../../src/mcp/repository-tools.js";
import { answerPacketSchema } from "../../src/mcp/schemas.js";
import { openDatabase } from "../../src/storage/database.js";
import { upsertEdge } from "../../src/storage/edges.js";
import { upsertNode } from "../../src/storage/nodes.js";
import type { GraphNode } from "../../src/graph/types.js";
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

  it("prioritizes a handler path ahead of more than 150 noisy trace edges", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/flow.ts", "export function start(): void {}\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "best-first trace fixture");
    await initializeRepository(repository.root);
    const context = await ensureFreshIndex(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database);
    let startId: string;
    try {
      startId = database
        .prepare("SELECT id FROM nodes WHERE qualified_name = 'start'")
        .pluck()
        .get() as string;
      const timestamp = new Date().toISOString();
      const testNode = (id: string, name: string): GraphNode => ({
        id,
        kind: "function",
        name,
        qualifiedName: name,
        filePath: "src/flow.ts",
        language: "typescript",
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 38,
        signature: null,
        visibility: "public",
        contentHash: null,
        sourceType: "ast",
        provenance: "verified",
        confidence: 1,
        metadata: {
          evidence: { source_type: "ast", file: "src/flow.ts", line: 1, column: 0 },
        },
      });
      const write = database.transaction(() => {
        upsertNode(database, testNode("important-handler", "importantHandler"), timestamp);
        upsertEdge(database, {
          id: "important-handles-edge",
          sourceNodeId: startId,
          targetNodeId: "important-handler",
          edgeType: "HANDLES",
          sourceType: "framework",
          provenance: "verified",
          confidence: 1,
          filePath: "src/flow.ts",
          line: 1,
          metadata: {
            evidence: { source_type: "framework", file: "src/flow.ts", line: 1, column: 0 },
          },
        }, timestamp);
        for (let index = 0; index < 160; index += 1) {
          const nodeId = `noisy-call-${index.toString().padStart(3, "0")}`;
          upsertNode(database, testNode(nodeId, nodeId), timestamp);
          upsertEdge(database, {
            id: `noisy-call-edge-${index.toString().padStart(3, "0")}`,
            sourceNodeId: startId,
            targetNodeId: nodeId,
            edgeType: "CALLS",
            sourceType: "ast",
            provenance: "verified",
            confidence: 1,
            filePath: "src/flow.ts",
            line: 1,
            metadata: {
              evidence: { source_type: "ast", file: "src/flow.ts", line: 1, column: 0 },
            },
          }, timestamp);
        }
      });
      write();
    } finally {
      database.close();
    }

    const response = answerPacketSchema.parse(
      tracePacket(context, { start: startId!, max_depth: 1, limit: 50 }),
    );
    expect(response.relationships).toContainEqual(
      expect.objectContaining({
        edge_type: "HANDLES",
        target_node_id: "important-handler",
      }),
    );
    expect(response.relationships).toHaveLength(DEFAULT_CONFIG.limits.maxExecutionPaths);
  });

  it("reports authoritative versus watched-cache freshness truthfully", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/status.ts", "export const status = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "freshness metadata fixture");
    await initializeRepository(repository.root);

    const authoritative = statusPacket(await ensureFreshIndex(repository.root));
    expect(authoritative.freshness).toMatchObject({
      mode: "authoritative",
      working_tree_checked: true,
      reconciliation_max_age_ms: 30_000,
    });
    const cached = statusPacket(await ensureFreshIndex(repository.root));
    expect(cached.freshness).toMatchObject({
      mode: "watch_cache",
      working_tree_checked: false,
      authoritative_checked_at: authoritative.freshness.authoritative_checked_at,
      reconciliation_max_age_ms: 30_000,
    });
    expect(cached.freshness.request_at >= cached.freshness.authoritative_checked_at).toBe(true);
  });

  it("paginates all dependencies and feature members beyond the configured 200-node cap", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/hub.ts", "export function hub(): void {}\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "pagination fixture");
    await initializeRepository(repository.root);
    const context = await ensureFreshIndex(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database);
    let hubId: string;
    const featureId = "feature-pagination-fixture";
    const memberIds: string[] = [];
    try {
      hubId = database
        .prepare("SELECT id FROM nodes WHERE qualified_name = 'hub'")
        .pluck()
        .get() as string;
      const timestamp = new Date().toISOString();
      const baseNode = (input: Pick<GraphNode, "id" | "kind" | "name" | "qualifiedName">): GraphNode => ({
        ...input,
        filePath: "src/hub.ts",
        language: "typescript",
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 31,
        signature: null,
        visibility: "public",
        contentHash: null,
        sourceType: input.kind === "feature" ? "heuristic" : "ast",
        provenance: input.kind === "feature" ? "inferred" : "verified",
        confidence: 1,
        metadata: {
          evidence: { source_type: "ast", file: "src/hub.ts", line: 1, column: 0 },
        },
      });
      upsertNode(
        database,
        baseNode({ id: featureId, kind: "feature", name: "Pagination", qualifiedName: "Pagination" }),
        timestamp,
      );
      const write = database.transaction(() => {
        for (let index = 0; index < 230; index += 1) {
          const memberId = `pagination-member-${index.toString().padStart(3, "0")}`;
          memberIds.push(memberId);
          upsertNode(
            database,
            baseNode({
              id: memberId,
              kind: "function",
              name: `member${index}`,
              qualifiedName: `member${index}`,
            }),
            timestamp,
          );
          upsertEdge(
            database,
            {
              id: `pagination-dependency-${index}`,
              sourceNodeId: hubId,
              targetNodeId: memberId,
              edgeType: "REFERENCES",
              sourceType: "ast",
              provenance: "verified",
              confidence: 1,
              filePath: "src/hub.ts",
              line: 1,
              metadata: {
                evidence: { source_type: "ast", file: "src/hub.ts", line: 1, column: 0 },
              },
            },
            timestamp,
          );
          upsertEdge(
            database,
            {
              id: `pagination-membership-${index}`,
              sourceNodeId: memberId,
              targetNodeId: featureId,
              edgeType: "BELONGS_TO_FEATURE",
              sourceType: "heuristic",
              provenance: "inferred",
              confidence: 0.9,
              filePath: "src/hub.ts",
              line: 1,
              metadata: {
                evidence: { source_type: "heuristic", file: "src/hub.ts", line: 1, column: 0 },
              },
            },
            timestamp,
          );
        }
      });
      write();
    } finally {
      database.close();
    }

    const dependencies = new Set<string>();
    let dependencyCursor: string | null = null;
    do {
      const page = dependenciesPacket(context, {
        target: hubId!,
        direction: "outgoing",
        limit: 50,
        cursor: dependencyCursor,
      });
      for (const relationship of page.relationships) {
        dependencies.add(relationship.target_node_id);
        expect(relationship.target?.name).toMatch(/^member\d+$/u);
      }
      dependencyCursor = page.pagination.cursor;
    } while (dependencyCursor !== null);
    expect(dependencies).toEqual(new Set(memberIds));

    const featureMembers = new Set<string>();
    let featureCursor: string | null = null;
    do {
      const page = explainFeaturePacket(context, {
        feature: featureId,
        limit: 50,
        cursor: featureCursor,
      });
      for (const relationship of page.relationships) {
        if (relationship.edge_type === "BELONGS_TO_FEATURE") {
          featureMembers.add(relationship.source_node_id);
        }
      }
      featureCursor = page.pagination.cursor;
    } while (featureCursor !== null);
    expect(featureMembers).toEqual(new Set(memberIds));
  });
});
