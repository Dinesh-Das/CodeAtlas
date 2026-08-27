import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { indexRepository } from "../../src/cli/index-command.js";
import { workspacePaths } from "../../src/core/workspace.js";
import {
  architectureHealthPacket,
  architectureOverviewPacket,
} from "../../src/mcp/architecture.js";
import { ensureFreshIndex } from "../../src/mcp/freshness.js";
import { answerPacketSchema } from "../../src/mcp/schemas.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

function checkoutSource(version: number): string {
  return [
    'import { alpha } from "../auth/a.js";',
    'import { save } from "./repository.js";',
    'import { cents } from "../shared/money.js";',
    "export function checkout(): number {",
    `  const version = ${version};`,
    "  const first = alpha();",
    "  const second = save();",
    "  const third = cents();",
    "  const fourth = first + second;",
    "  const fifth = third + fourth;",
    "  const sixth = fifth + version;",
    "  const seventh = sixth + first;",
    "  const eighth = seventh + second;",
    "  const ninth = eighth + third;",
    "  const tenth = ninth + fourth;",
    "  const eleventh = tenth + fifth;",
    "  const twelfth = eleventh + sixth;",
    "  return twelfth;",
    "}",
    "",
  ].join("\n");
}

async function createArchitectureRepository(): Promise<TestRepository> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await repository.write(
    "src/auth/a.ts",
    'import { beta } from "./b.js";\nexport function alpha(): number { return beta(); }\n',
  );
  await repository.write(
    "src/auth/b.ts",
    'import { alpha } from "./a.js";\nexport function beta(): number { return alpha(); }\n',
  );
  await repository.write(
    "src/payments/repository.ts",
    "export function save(): number { return 1; }\n",
  );
  await repository.write("src/payments/service.ts", checkoutSource(1));
  await repository.write(
    "src/payments/routes.ts",
    'import express from "express";\nimport { checkout } from "./service.js";\nconst app = express();\napp.post("/checkout", checkout);\n',
  );
  await repository.write(
    "src/shared/money.ts",
    "export function cents(): number { return 100; }\n",
  );
  await repository.write(
    "src/notifications/sender.ts",
    "export function sendNotification(): boolean { return true; }\n",
  );
  await repository.write(
    "prisma/schema.prisma",
    "model Payment {\n  id Int @id\n}\n",
  );
  await repository.git("add", ".");
  await repository.git("commit", "-m", "architecture fixture");
  await repository.write("src/payments/service.ts", checkoutSource(2));
  await repository.git("add", "src/payments/service.ts");
  await repository.git("commit", "-m", "update checkout flow");
  await repository.write("src/payments/service.ts", checkoutSource(3));
  await repository.git("add", "src/payments/service.ts");
  await repository.git("commit", "-m", "refine checkout flow");
  return repository;
}

describe("Phase 6 architecture analysis", () => {
  it("persists features, domains, communities, metrics, cycles, and hotspots", async () => {
    const repository = await createArchitectureRepository();
    await initializeRepository(repository.root);
    const configPath = workspacePaths(repository.root).config;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      limits: {
        largeFileLines: number;
        largeSymbolLines: number;
        highFanIn: number;
        highFanOut: number;
      };
    };
    config.limits.largeFileLines = 20;
    config.limits.largeSymbolLines = 10;
    config.limits.highFanIn = 2;
    config.limits.highFanOut = 2;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({
      fullRebuild: true,
      features: expect.any(Number),
      domains: expect.any(Number),
      communities: expect.any(Number),
      cycles: expect.any(Number),
      hotspots: expect.any(Number),
    });
    expect(result.features).toBeGreaterThanOrEqual(3);
    expect(result.domains).toBeGreaterThanOrEqual(5);
    expect(result.communities).toBeGreaterThanOrEqual(3);
    expect(result.cycles).toBeGreaterThanOrEqual(1);
    expect(result.hotspots).toBeGreaterThanOrEqual(1);

    const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
    try {
      const feature = database
        .prepare(
          `SELECT id, confidence, metadata_json AS metadataJson
           FROM nodes WHERE kind = 'feature' AND name = 'Payments'`,
        )
        .get() as { id: string; confidence: number; metadataJson: string };
      expect(feature.confidence).toBeGreaterThanOrEqual(0.5);
      expect(JSON.parse(feature.metadataJson)).toMatchObject({
        evidence: { file: expect.stringContaining("payments"), line: 1 },
        signal: "directory_semantic_cluster",
      });
      expect(
        database
          .prepare(
            "SELECT count(*) FROM edges WHERE edge_type = 'BELONGS_TO_FEATURE' AND target_node_id = ?",
          )
          .pluck()
          .get(feature.id),
      ).toBeGreaterThan(2);

      const metric = database
        .prepare(
          `SELECT fan_in AS fanIn, fan_out AS fanOut,
                  cross_domain_dependencies AS crossDomainDependencies,
                  recent_commit_count AS recentCommitCount, recent_churn AS recentChurn,
                  hotspot_score AS hotspotScore
           FROM architecture_metrics WHERE file_path = 'src/payments/service.ts'`,
        )
        .get() as Record<string, number>;
      expect(metric.fanOut).toBeGreaterThanOrEqual(3);
      expect(metric.crossDomainDependencies).toBeGreaterThanOrEqual(2);
      expect(metric.recentCommitCount).toBe(3);
      expect(metric.recentChurn).toBeGreaterThan(0);
      expect(metric.hotspotScore).toBeGreaterThan(0);

      const findingTypes = database
        .prepare("SELECT DISTINCT finding_type FROM architecture_findings ORDER BY finding_type")
        .all()
        .map((row) => (row as { finding_type: string }).finding_type);
      expect(findingTypes).toEqual(
        expect.arrayContaining([
          "change_hotspot",
          "circular_dependency",
          "high_fan_out",
          "large_symbol",
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("returns paginated, evidence-bearing overview and health packets", async () => {
    const repository = await createArchitectureRepository();
    await initializeRepository(repository.root);
    const context = await ensureFreshIndex(repository.root);
    const firstOverview = answerPacketSchema.parse(
      architectureOverviewPacket(context, { cursor: null, limit: 2 }),
    );
    expect(firstOverview.facts).toHaveLength(2);
    expect(firstOverview.pagination).toMatchObject({ has_more: true });
    expect(firstOverview.pagination.cursor).not.toBeNull();
    for (const fact of firstOverview.facts) {
      expect(fact.evidence.file).not.toBe("");
      expect(fact.evidence.line).toBeGreaterThan(0);
    }
    const secondOverview = answerPacketSchema.parse(
      architectureOverviewPacket(context, {
        cursor: firstOverview.pagination.cursor,
        limit: 2,
      }),
    );
    expect(secondOverview.facts).toHaveLength(2);
    expect(secondOverview.facts).not.toEqual(firstOverview.facts);

    const health = answerPacketSchema.parse(
      architectureHealthPacket(context, { cursor: null, limit: 20 }),
    );
    expect(health.facts.length).toBeGreaterThan(0);
    expect(health.facts.some((fact) => fact.statement.includes("Circular dependency"))).toBe(true);
    expect(health.relationships.length).toBeGreaterThan(0);
    expect(health.uncertainties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "heuristic_only" }),
      ]),
    );
  });

  it("removes feature nodes when optional feature detection is disabled", async () => {
    const repository = await createArchitectureRepository();
    await initializeRepository(repository.root);
    const configPath = workspacePaths(repository.root).config;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      analysis: { featureDetection: boolean };
    };
    config.analysis.featureDetection = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = await indexRepository(repository.root);
    expect(result).toMatchObject({ fullRebuild: true, features: 0 });
    expect(result.domains).toBeGreaterThan(0);
  });
});
