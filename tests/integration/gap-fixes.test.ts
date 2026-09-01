import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { getStatus } from "../../src/cli/status.js";
import { indexRepository } from "../../src/cli/index-command.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { registerFrameworkAdapter } from "../../src/framework/registry.js";
import type { FrameworkAdapter } from "../../src/framework/types.js";
import { getNodePacket } from "../../src/mcp/graph-tools.js";
import { ensureFreshIndex } from "../../src/mcp/freshness.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("gap-fix evidence and resilience", () => {
  it("records callbacks, events, queues, DI, reflection, and generated code without guessing", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/runtime.ts",
      [
        "export class Service {}",
        "export function handler(): void {}",
        "export function run(bus: any, queue: any, container: any, handlers: any, key: string): void {",
        "  setTimeout(handler, 1);",
        "  bus.on(key, handler);",
        "  bus.emit(key);",
        "  queue.process(handler);",
        "  queue.publish(key);",
        "  container.resolve(Service);",
        "  handlers[key]();",
        "}",
        "",
      ].join("\n"),
    );
    await repository.write(
      "src/generated/client.ts",
      "// @generated - do not edit\nexport function generatedClient(): boolean { return true; }\n",
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "dynamic behavior fixture");
    await initializeRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    let runId: string;
    try {
      runId = database
        .prepare("SELECT id FROM nodes WHERE qualified_name = 'run'")
        .pluck()
        .get() as string;
      const dynamicEdges = database
        .prepare(
          `SELECT edge_type AS edgeType, confidence, provenance_category AS provenance
           FROM edges WHERE source_node_id = ? AND provenance_category = 'dynamic'
           ORDER BY edge_type, line`,
        )
        .all(runId) as Array<{ edgeType: string; confidence: number; provenance: string }>;
      expect(dynamicEdges.map((edge) => edge.edgeType)).toEqual(
        expect.arrayContaining(["CALLS", "SUBSCRIBES", "DEPENDS_ON"]),
      );
      expect(dynamicEdges.every((edge) => edge.confidence < 1)).toBe(true);
      expect(dynamicEdges.every((edge) => edge.provenance === "dynamic")).toBe(true);

      const issues = database
        .prepare(
          `SELECT reason, reference_kind AS referenceKind
           FROM resolution_issues ORDER BY file_path, line`,
        )
        .all() as Array<{ reason: string; referenceKind: string }>;
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "dynamic_relationship", referenceKind: "event_publish" }),
          expect.objectContaining({ reason: "dynamic_relationship", referenceKind: "queue_publish" }),
          expect.objectContaining({ reason: "generated_code", referenceKind: "generated" }),
        ]),
      );
      expect(
        database
          .prepare(
            `SELECT count(*) FROM nodes
             WHERE file_path = 'src/generated/client.ts' AND provenance_category = 'dynamic'`,
          )
          .pluck()
          .get(),
      ).toBeGreaterThan(0);
    } finally {
      database.close();
    }

    const context = await ensureFreshIndex(repository.root);
    const packet = getNodePacket(context, { node_id: runId! });
    expect(packet.relationships.some((edge) => edge.provenance === "dynamic")).toBe(true);
    expect(packet.uncertainties).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "dynamic_relationship" })]),
    );
    expect(packet.security).toMatchObject({
      indexing: "local_only",
      repository_content: "untrusted",
      answer_policy: "evidence_only",
    });

    const doctor = await runDoctor(repository.root);
    expect(doctor).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Dynamic relationship labeling",
          ok: true,
          severity: "info",
        }),
      ]),
    );
  });

  it("combines feature signals, indexes architectural intent, and honors manual overrides", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/orders/service.ts",
      "export function orderService(): boolean { return true; }\n",
    );
    await repository.write(
      "src/orders/routes.ts",
      'import express from "express";\nimport { orderService } from "./service.js";\nconst app = express();\napp.get("/orders", orderService);\n',
    );
    await repository.write(
      "src/orders/service.test.ts",
      'import { orderService } from "./service.js";\nexport function verifiesOrders(): boolean { return orderService(); }\n',
    );
    await repository.write(
      "src/payments/service.ts",
      "// INVARIANT: payment writes are idempotent\nexport function charge(): boolean { return true; }\n",
    );
    await repository.write(
      "docs/adr/0001-orders.md",
      "# Orders boundary\n\n## Decision\nOrders own route orchestration.\n",
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "feature evidence fixture");
    await initializeRepository(repository.root);

    const configPath = workspacePaths(repository.root).config;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      analysis: { featureOverrides: unknown[] };
    };
    config.analysis.featureOverrides = [
      {
        name: "Billing",
        include: ["src/payments/**"],
        exclude: [],
        confidence: 1,
      },
    ];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await indexRepository(repository.root);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const orders = database
        .prepare(
          `SELECT confidence, provenance_category AS provenance, metadata_json AS metadata
           FROM nodes WHERE kind = 'feature' AND name = 'Orders'`,
        )
        .get() as { confidence: number; provenance: string; metadata: string };
      const signals = (JSON.parse(orders.metadata) as {
        supporting_evidence: Array<{ signal: string }>;
      }).supporting_evidence.map((signal) => signal.signal);
      expect(orders.confidence).toBeGreaterThanOrEqual(0.8);
      expect(orders.provenance).toBe("inferred");
      expect(signals).toEqual(
        expect.arrayContaining([
          "directory_structure",
          "symbol_name",
          "route",
          "test_coverage",
          "imports",
          "graph_community",
        ]),
      );

      const billing = database
        .prepare(
          `SELECT id, confidence, source_type AS sourceType,
                  provenance_category AS provenance, metadata_json AS metadata
           FROM nodes WHERE kind = 'feature' AND name = 'Billing'`,
        )
        .get() as {
          id: string;
          confidence: number;
          sourceType: string;
          provenance: string;
          metadata: string;
        };
      expect(billing).toMatchObject({ confidence: 1, sourceType: "config", provenance: "verified" });
      expect(JSON.parse(billing.metadata)).toMatchObject({ signal: "manual_override" });
      expect(
        database
          .prepare(
            `SELECT count(*) FROM edges
             WHERE target_node_id = ? AND edge_type = 'BELONGS_TO_FEATURE'
               AND source_type = 'config'`,
          )
          .pluck()
          .get(billing.id),
      ).toBeGreaterThan(0);

      expect(
        database
          .prepare(
            `SELECT count(*) FROM nodes
             WHERE kind = 'documentation' AND provenance_category = 'documentation'`,
          )
          .pluck()
          .get(),
      ).toBeGreaterThanOrEqual(3);
      expect(
        database.prepare("SELECT count(*) FROM nodes WHERE kind = 'test'").pluck().get(),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("isolates optional framework adapter failures and retains generic AST facts", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write(
      "src/custom-gap.ts",
      "export function genericFallback(): boolean { return true; }\n",
    );
    await repository.git("add", ".");
    await repository.git("commit", "-m", "adapter fallback fixture");

    const failingAdapter: FrameworkAdapter = {
      name: "failing-test-adapter",
      version: "1",
      supports: (relativeFilePath) => relativeFilePath === "src/custom-gap.ts",
      detect: () => true,
      extractRoutes: () => {
        throw new Error("intentional adapter failure");
      },
      extractModels: () => [],
      extractFrameworkRelationships: () => [],
    };
    const unregister = registerFrameworkAdapter(failingAdapter);
    try {
      await initializeRepository(repository.root);
    } finally {
      unregister();
    }

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      expect(
        database
          .prepare("SELECT count(*) FROM nodes WHERE qualified_name = 'genericFallback'")
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database
          .prepare(
            `SELECT json_extract(metadata_json, '$.frameworkAdapterFailureCount')
             FROM nodes WHERE kind = 'file' AND file_path = 'src/custom-gap.ts'`,
          )
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("detects staged-only state even when working-tree content matches the indexed file", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    const original = "export const state = 'working';\n";
    await repository.write("src/state.ts", original);
    await repository.git("add", ".");
    await repository.git("commit", "-m", "freshness fixture");
    await initializeRepository(repository.root);

    await repository.write("src/state.ts", "export const state = 'staged';\n");
    await repository.git("add", "src/state.ts");
    await repository.write("src/state.ts", original);

    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: false });
    await ensureFreshIndex(repository.root);
    await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
  });
});
