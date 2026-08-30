import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepository } from "../../src/compiler/build.js";
import { runGit } from "../../src/git/repository.js";
import { compareSnapshots } from "../../src/git/snapshots.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { evidenceIr, findSymbolIr, flowIr, impactIr } from "../../src/mcp/ir-tools.js";
import type { Atlas } from "../../src/ir/models.js";
import { validateAtlas } from "../../src/ir/validation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-v2-"));
  roots.push(root);
  await cp(path.resolve("tests/fixtures/v2-architecture"), root, { recursive: true });
  await runGit(root, ["init"]);
  await runGit(root, ["config", "user.name", "CodeAtlas Tests"]);
  await runGit(root, ["config", "user.email", "codeatlas@example.invalid"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-m", "fixture"]);
  return root;
}

describe("codeatlas build v2", () => {
  it("creates a valid offline IR/HTML, flows, CFGs, impact, rules, and a snapshot", async () => {
    const root = await repositoryFixture();
    const first = await buildRepository(root);
    const atlas = JSON.parse(await readFile(path.join(first.currentDirectory, "atlas.json"), "utf8")) as Atlas;
    expect(validateAtlas(atlas)).toEqual({ valid: true, errors: [] });
    expect(atlas.schema_version).toBe("1.0");
    expect(atlas.domains.some((domain) => domain.name === "authentication" && domain.label_provenance === "USER_DEFINED")).toBe(true);
    expect(atlas.flows.some((flow) => flow.steps.length > 1)).toBe(true);
    const authenticate = atlas.symbols.find((symbol) => symbol.qualified_name === "authenticate");
    expect(atlas.control_flows.find((flow) => flow.symbol_id === authenticate?.id)?.nodes.map((node) => node.kind))
      .toEqual(expect.arrayContaining(["START", "CONDITION", "LOOP", "TRY", "CATCH", "RETURN", "RAISE", "END"]));
    expect(atlas.rule_violations.some((item) => item.rule_id === "controllers-must-not-call-repositories")).toBe(true);
    expect(atlas.review_findings.every((finding) => finding.evidence_ids.length > 0)).toBe(true);
    const endpoint = atlas.symbols.find((symbol) => symbol.kind === "endpoint")!;
    const [found, impact, execution, evidence] = await Promise.all([
      findSymbolIr(root, "authenticate", 10),
      impactIr(root, "authenticate", 8, 100),
      flowIr(root, endpoint.id),
      evidenceIr(root, "authenticate"),
    ]);
    expect(found.results.some((symbol) => symbol.qualified_name === "authenticate")).toBe(true);
    expect(impact.paths.length).toBeGreaterThan(0);
    expect(execution.flow?.steps).toEqual(atlas.flows.find((flow) => flow.entrypoint_id === endpoint.id)?.steps);
    expect(evidence.evidence.length).toBeGreaterThan(0);
    const html = await readFile(first.htmlPath, "utf8");
    expect(html).toContain('id="atlas-data"');
    expect(html).toContain("Overview");
    expect(html).toContain("Entrypoints");
    expect(html).not.toMatch(/<script[^>]+src=/iu);
    expect(html).not.toMatch(/<link[^>]+href=/iu);
    await expect(stat(path.join(root, ".codeatlas", "snapshots", first.snapshotId, "atlas.json"))).resolves.toBeDefined();

    const second = await buildRepository(root);
    expect(second.parsedFiles).toBe(0);
    expect(second.reusedFiles).toBe(first.statistics.files);
  }, 60_000);

  it("maps changed lines to symbols and compares persistent snapshots", async () => {
    const root = await repositoryFixture();
    const first = await buildRepository(root);
    const servicePath = path.join(root, "src", "auth", "service.ts");
    const source = await readFile(servicePath, "utf8");
    await writeFile(servicePath, source.replace('return password.length > 7 ? "token" : "unauthorized";', 'return password.length > 9 ? "token" : "unauthorized";'), "utf8");
    await runGit(root, ["add", "src/auth/service.ts"]);
    await runGit(root, ["commit", "-m", "change authentication policy"]);
    const second = await buildRepository(root, { gitBase: first.snapshotId });
    const atlas = JSON.parse(await readFile(path.join(second.currentDirectory, "atlas.json"), "utf8")) as Atlas;
    const change = atlas.git_changes.find((item) => item.file === "src/auth/service.ts");
    expect(change?.line_ranges.length).toBeGreaterThan(0);
    expect(change?.symbol_ids.map((id) => atlas.symbols.find((symbol) => symbol.id === id)?.qualified_name))
      .toContain("authenticate");
    const diff = await compareSnapshots(workspacePaths(root).snapshots, first.snapshotId, second.snapshotId);
    expect(diff.symbols.modified.length).toBeGreaterThan(0);
  }, 60_000);
});
