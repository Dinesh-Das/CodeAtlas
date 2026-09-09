import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepository } from "../../src/compiler/build.js";
import { workspacePaths } from "../../src/core/workspace.js";
import type { KnowledgeReport } from "../../src/knowledge/system.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("living repository knowledge", () => {
  it("generates a short agent map and actionable ADR/config findings", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/service.ts", [
      "export function startService(): boolean {",
      "  return true;",
      "}",
      "",
    ].join("\n"));
    await repository.write("tests/service.test.ts", [
      'import { startService } from "../src/service.js";',
      "export function serviceTest(): boolean { return startService(); }",
      "",
    ].join("\n"));
    await repository.write("docs/adrs/0001-service.md", [
      "# Run the core service in process",
      "",
      "Status: Accepted",
      "Owner: platform-team",
      "Last Reviewed: 2020-01-01",
      "Supersedes: ADR-999",
      "",
      "## Decision",
      "Keep one process boundary.",
      "",
    ].join("\n"));
    await repository.write("docs/SECURITY.md", "# Security\n\nSee the pinned invariants.\n");
    await repository.write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }, null, 2));
    await repository.write(".codeatlas.yml", [
      "version: 1",
      "knowledge:",
      "  max_documentation_age_days: 30",
      "  owners:",
      "    - id: core-service",
      "      owner: platform-team",
      "      purpose: Start the application service",
      "      include: [src/**]",
      "      entrypoint: startService",
      "      contracts: [startService]",
      "      validation_command: npm run test",
      "  journeys:",
      "    - id: service-start",
      "      name: Service startup",
      "      purpose: Start the process",
      "      entrypoint: startService",
      "  invariants:",
      "    - id: startup-result",
      "      statement: Startup returns a success result",
      "      applies_to: [src/**]",
      "  canonical_names:",
      "    - symbol: startService",
      "      name: Core service entrypoint",
      "",
    ].join("\n"));
    await repository.git("add", ".");
    await repository.git("commit", "-m", "knowledge fixture");

    await buildRepository(repository.root, { snapshot: false });
    const paths = workspacePaths(repository.root);
    const map = await readFile(`${paths.agent}/map.md`, "utf8");
    const report = JSON.parse(await readFile(`${paths.agent}/knowledge.json`, "utf8")) as KnowledgeReport;

    expect(map.split(/\r?\n/u).length).toBeLessThanOrEqual(150);
    expect(map).toContain("# CodeAtlas agent map");
    expect(map).toContain("owner: platform-team");
    expect(map).toContain("human_config");
    expect(map).toContain("Generated architecture");
    expect(report.systems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "core-service",
        owner: "platform-team",
        purpose: "Start the application service",
        entrypoint_id: expect.any(String),
        contract_ids: [expect.any(String)],
        validation_command: "npm run test",
        provenance: "human_config",
      }),
    ]));
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "adr_stale", file: "docs/adrs/0001-service.md" }),
      expect.objectContaining({ code: "adr_supersession_target_missing", file: "docs/adrs/0001-service.md" }),
    ]));
    expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("Keep one process boundary");

    const configPath = ".codeatlas.yml";
    const config = await readFile(`${repository.root}/${configPath}`, "utf8");
    await repository.write(configPath, config.replace(
      "      entrypoint: startService\n  invariants:",
      "      entrypoint: missingEntrypoint\n  invariants:",
    ));
    await buildRepository(repository.root, { snapshot: false });
    const contradictory = JSON.parse(
      await readFile(`${paths.agent}/knowledge.json`, "utf8"),
    ) as KnowledgeReport;
    expect(contradictory.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "journey_entrypoint_missing", severity: "error" }),
    ]));
  }, 45_000);
});
