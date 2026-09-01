import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepository } from "../../src/compiler/build.js";
import { runGit } from "../../src/git/repository.js";
import { compareSnapshots } from "../../src/git/snapshots.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { callersIr, evidenceIr, findSymbolIr, flowIr, impactIr, snapshotIr } from "../../src/mcp/ir-tools.js";
import { ensureFreshIndex } from "../../src/mcp/freshness.js";
import { statusPacket } from "../../src/mcp/repository-tools.js";
import type { Atlas } from "../../src/ir/models.js";
import { semanticAtlasJson } from "../../src/ir/serialization.js";
import { validateAtlas } from "../../src/ir/validation.js";

const roots: string[] = [];

function embeddedAtlas(html: string): Atlas {
  const encoded = /<script id="atlas-data"[^>]*>([^<]+)<\/script>/u.exec(html)?.[1];
  if (!encoded) throw new Error("Compressed atlas-data was not embedded in the HTML export.");
  return JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")) as Atlas;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repositoryFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codeatlas-v2-")));
  roots.push(root);
  await cp(path.resolve("tests/fixtures/v2-architecture"), root, { recursive: true });
  await runGit(root, ["init"]);
  await runGit(root, ["config", "user.name", "CodeAtlas Tests"]);
  await runGit(root, ["config", "user.email", "codeatlas@example.invalid"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-m", "fixture"]);
  return root;
}

async function filesystemFixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "codeatlas-v2-filesystem-")),
  );
  roots.push(root);
  await cp(path.resolve("tests/fixtures/v2-architecture"), root, { recursive: true });
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
    expect(authenticate).toBeDefined();
    const authentication = atlas.domains.find((domain) => domain.name === "authentication")!;
    const endpoint = atlas.symbols.find((symbol) =>
      symbol.kind === "endpoint" && symbol.metadata.http_method === "POST" && symbol.name === "POST login",
    )!;
    const loginFlow = atlas.flows.find((flow) => flow.entrypoint_id === endpoint.id)!;
    const loginFlowSymbols = loginFlow.steps.map((step) => atlas.symbols.find((symbol) => symbol.id === step.symbol_id)!);
    const authFile = atlas.symbols.find((symbol) => symbol.kind === "file" && symbol.file === authenticate?.file)!;

    expect(loginFlowSymbols.slice(0, 3).map((symbol) => [symbol.file, symbol.qualified_name])).toEqual([
      ["src/app.ts", endpoint.qualified_name],
      ["src/app.ts", "login"],
      ["src/auth/controller.ts", "login"],
    ]);
    expect(loginFlowSymbols.some((symbol) => symbol.file === "src/auth/service.ts" && symbol.qualified_name === "authenticate")).toBe(true);
    expect(loginFlowSymbols.some((symbol) => symbol.file === "src/auth/repository.ts" && symbol.qualified_name === "findUserRepository")).toBe(true);
    expect(authentication.member_ids).toContain(authenticate!.id);
    expect(loginFlow.steps.some((step) => step.symbol_id === authenticate!.id)).toBe(true);
    expect(authFile.id).toBeDefined();

    const authenticateCfg = atlas.control_flows.find((flow) => flow.symbol_id === authenticate?.id);
    expect(authenticateCfg?.nodes.map((node) => node.kind))
      .toEqual(expect.arrayContaining(["START", "CONDITION", "LOOP", "TRY", "CATCH", "RETURN", "RAISE", "END"]));
    const astCfgNodes = authenticateCfg?.nodes.filter((node) => !["START", "END"].includes(node.kind)) ?? [];
    expect(astCfgNodes.length).toBeGreaterThan(0);
    expect(astCfgNodes.every((node) => node.evidence_ids.length === 1)).toBe(true);
    expect(astCfgNodes.every((node) => {
      const evidence = atlas.evidence.find((item) => item.id === node.evidence_ids[0]);
      return evidence?.file === authenticate?.file && evidence.start_line >= (authenticate?.location?.start_line ?? 0);
    })).toBe(true);
    expect(authenticateCfg?.edges.map((edge) => edge.label))
      .toEqual(expect.arrayContaining(["true", "false", "body", "exit", "repeat", "try", "catch", "return", "raise"]));
    expect(atlas.rule_violations.some((item) => item.rule_id === "controllers-must-not-call-repositories")).toBe(true);
    expect(atlas.review_findings.every((finding) => finding.evidence_ids.length > 0)).toBe(true);
    const [found, callers, impact, execution, evidence] = await Promise.all([
      findSymbolIr(root, "authenticate", 10),
      callersIr(root, authenticate!.id, 100),
      impactIr(root, "authenticate", 8, 100),
      flowIr(root, endpoint.id),
      evidenceIr(root, "authenticate"),
    ]);
    expect(found.results.find((symbol) => symbol.id === authenticate!.id)).toEqual(authenticate);
    const canonicalCallerRelationships = atlas.relationships.filter((relationship) =>
      relationship.target === authenticate!.id && ["CALLS", "HANDLES", "TRIGGERS", "MAY_CONTINUE_TO"].includes(relationship.type),
    );
    expect(callers.relationships).toEqual(canonicalCallerRelationships);
    expect(callers.callers.map((symbol) => symbol.id).sort()).toEqual(
      canonicalCallerRelationships.map((relationship) => relationship.source).sort(),
    );
    expect(impact.paths.length).toBeGreaterThan(0);
    expect(impact.direct_callers.length).toBeGreaterThan(0);
    expect(impact.direct_dependencies.length).toBeGreaterThan(0);
    expect(impact.transitive_callers.length).toBeGreaterThan(impact.direct_callers.length);
    expect(impact.affected_files).toContain("src/auth/service.ts");
    expect(impact.affected_domains.length).toBeGreaterThan(0);
    expect(impact.affected_entrypoints.length).toBeGreaterThan(0);
    expect(impact.affected_apis.length).toBeGreaterThan(0);
    expect(impact.affected_tests.length).toBeGreaterThan(0);
    expect(impact.score?.components.centrality).toBeDefined();
    expect(impact.score?.components.public_api).toBeDefined();
    expect(impact.score?.components.database_schema).toBeDefined();
    expect(impact.score?.components.missing_test_coverage).toBeDefined();
    expect(impact.score?.components.architecture_rules).toBeDefined();
    expect(execution.flow).toEqual(loginFlow);
    expect(evidence.symbol).toEqual(authenticate);
    expect(evidence.evidence).toEqual(
      atlas.evidence.filter((item) => authenticate!.evidence_ids.includes(item.id)),
    );
    const html = await readFile(first.htmlPath, "utf8");
    expect(html).toContain('id="atlas-data"');
    expect(html).toContain('id="projection-data"');
    expect(html).toContain('id="hub-data"');
    expect(html).toContain("Overview");
    expect(html).toContain("Entrypoints");
    expect(html).toContain("Aggregate dependencies");
    expect(html).toContain("Representative paths");
    expect(html).toContain("Hide utility hubs");
    expect(html).toContain("Collapse utility hubs");
    expect(html).toContain("Show hubs");
    expect(html).toContain("rendering budget");
    expect(html).toContain("hierarchyCrumbs");
    const embedded = embeddedAtlas(html);
    expect(embedded.domains.map((domain) => domain.id)).toContain(authentication.id);
    expect(embedded.symbols.map((symbol) => symbol.id)).toEqual(
      expect.arrayContaining([endpoint.id, authFile.id, authenticate!.id]),
    );
    expect(html).toContain("deterministic");
    expect(html).toContain("Edges preserve branch labels");
    expect(html).toContain("Architecture-rule status");
    expect(html).toContain("Affected APIs");
    expect(html).toContain("Direct dependencies");
    expect(html).not.toMatch(/<script[^>]+src=/iu);
    expect(html).not.toMatch(/<link[^>]+href=/iu);
    await expect(stat(path.join(root, ".codeatlas", "snapshots", first.snapshotId, "atlas.json"))).resolves.toBeDefined();
    const snapshotSummary = await snapshotIr(root, first.snapshotId);
    expect(snapshotSummary).toMatchObject({
      section: "summary",
      items: [],
      snapshot: {
        snapshot: { id: first.snapshotId },
        sections: { symbols: atlas.symbols.length, relationships: atlas.relationships.length },
      },
      pagination: { has_more: false, cursor: null },
    });
    const snapshotPage1 = await snapshotIr(root, first.snapshotId, "symbols", 1);
    expect(snapshotPage1.items).toHaveLength(1);
    expect(snapshotPage1.pagination.cursor).toEqual(expect.any(String));
    const snapshotPage2 = await snapshotIr(
      root,
      first.snapshotId,
      "symbols",
      1,
      snapshotPage1.pagination.cursor ?? undefined,
    );
    expect(snapshotPage2.items).toHaveLength(1);
    expect((snapshotPage2.items[0] as { id: string }).id)
      .not.toBe((snapshotPage1.items[0] as { id: string }).id);

    const requiredTimingKeys = [
      "fileCollection",
      "parsing",
      "symbolExtraction",
      "relationshipResolution",
      "domainAnalysis",
      "flowGeneration",
      "cfgGeneration",
      "impactIndexing",
      "gitAnalysis",
      "htmlExport",
      "snapshotPersistence",
    ] as const;
    for (const key of requiredTimingKeys) {
      expect(Number.isFinite(first.timingsMs[key])).toBe(true);
      expect(first.timingsMs[key]).toBeGreaterThanOrEqual(0);
    }
    const buildMetadata = JSON.parse(
      await readFile(path.join(first.currentDirectory, "build.json"), "utf8"),
    ) as {
      parsed_files?: number;
      reused_files?: number;
      timings_ms?: Record<string, number>;
    };
    expect(buildMetadata.parsed_files).toBe(first.parsedFiles);
    expect(buildMetadata.reused_files).toBe(first.reusedFiles);
    for (const key of requiredTimingKeys) {
      expect(buildMetadata.timings_ms?.[key]).toBe(first.timingsMs[key]);
    }

    const second = await buildRepository(root);
    expect(second.parsedFiles).toBe(0);
    expect(second.reusedFiles).toBe(first.statistics.files);
    const secondAtlas = JSON.parse(
      await readFile(path.join(second.currentDirectory, "atlas.json"), "utf8"),
    ) as Atlas;
    expect(semanticAtlasJson(secondAtlas)).toBe(semanticAtlasJson(atlas));
  }, 60_000);

  it("supports deterministic single-file and sharded bundle output modes", async () => {
    const root = await repositoryFixture();
    const single = await buildRepository(root, { snapshot: false });
    expect(single.htmlMode).toBe("single-file");
    expect(single.bundlePath).toBeNull();
    expect(single.htmlPath).toBe(path.join(root, "codeatlas.html"));
    const singleHtml = await readFile(single.htmlPath, "utf8");
    expect(singleHtml).not.toMatch(/<script[^>]+src=/iu);
    expect(singleHtml).not.toMatch(/<link[^>]+href=/iu);

    await writeFile(path.join(root, ".codeatlas.yml"), "version: 1\nhtml:\n  mode: bundle\n", "utf8");
    const configuredBundle = await buildRepository(root, { snapshot: false });
    expect(configuredBundle.htmlMode).toBe("bundle");
    expect(configuredBundle.bundlePath).toBe(path.join(root, "codeatlas"));
    const manifest = JSON.parse(
      await readFile(path.join(root, "codeatlas", "data", "manifest.json"), "utf8"),
    ) as { files: string[]; shards: Record<string, string[]>; checksums: Record<string, string> };
    expect(manifest.shards.symbols?.[0]).toBe("symbols-001.json");
    expect(manifest.shards.relationships?.[0]).toBe("relationships-001.json");
    expect(manifest.files).toContain("domains.json");
    expect(manifest.files).toContain("symbols-001.json");
    expect(manifest.files).toContain("relationships-001.json");
    expect(Object.keys(manifest.checksums).sort()).toEqual([...manifest.files].sort());

    const forcedSingle = await buildRepository(root, { snapshot: false, singleFile: true });
    expect(forcedSingle.htmlMode).toBe("single-file");
    expect(forcedSingle.htmlPath).toBe(path.join(root, "codeatlas.html"));
    const forcedBundle = await buildRepository(root, { snapshot: false, bundle: true });
    expect(forcedBundle.htmlMode).toBe("bundle");
    await expect(buildRepository(root, { snapshot: false, bundle: true, singleFile: true }))
      .rejects.toThrow("Choose either --bundle or --single-file");
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

  it("classifies added, deleted, modified, and moved symbols with PR-aware detail", async () => {
    const root = await repositoryFixture();
    const baseCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    const servicePath = path.join(root, "src", "auth", "service.ts");
    const source = await readFile(servicePath, "utf8");
    await writeFile(
      servicePath,
      source.replace(
        'return password.length > 7 ? "token" : "unauthorized";',
        'return password.length > 9 ? "token" : "unauthorized";',
      ) + '\nexport function issueToken(): string { return "token"; }\n',
      "utf8",
    );
    await rm(path.join(root, "src", "admin", "service.ts"));
    await mkdir(path.join(root, "src", "billing"), { recursive: true });
    await runGit(root, ["mv", "src/payments/service.ts", "src/billing/service.ts"]);

    const result = await buildRepository(root, { gitBase: baseCommit, snapshot: false });
    const atlas = JSON.parse(await readFile(path.join(result.currentDirectory, "atlas.json"), "utf8")) as Atlas;
    const authChange = atlas.git_changes.find((item) => item.file === "src/auth/service.ts");
    const deletedChange = atlas.git_changes.find((item) => item.file === "src/admin/service.ts");
    const movedChange = atlas.git_changes.find((item) => item.file === "src/billing/service.ts");

    expect(authChange?.status).toBe("MODIFIED");
    expect(authChange?.symbol_changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "MODIFIED", qualified_name: "authenticate" }),
      expect.objectContaining({ status: "ADDED", qualified_name: "issueToken" }),
    ]));
    expect(authChange?.source_diff).toContain("password.length > 9");
    expect(authChange?.impacted_symbol_ids.length).toBeGreaterThan(0);
    expect(authChange?.related_test_ids.every((id) => atlas.symbols.some((symbol) => symbol.id === id))).toBe(true);
    expect(authChange?.rule_violation_ids.every((id) => atlas.rule_violations.some((violation) => violation.id === id))).toBe(true);
    expect(authChange?.review_finding_ids.every((id) => atlas.review_findings.some((finding) => finding.id === id))).toBe(true);

    expect(deletedChange?.status).toBe("DELETED");
    expect(deletedChange?.symbol_changes.some((symbol) => symbol.status === "DELETED")).toBe(true);
    expect(deletedChange?.source_diff).toContain("deleted file mode");

    expect(movedChange?.status).toBe("MOVED");
    expect(movedChange?.previous_file).toBe("src/payments/service.ts");
    expect(movedChange?.symbol_changes.some((symbol) =>
      symbol.status === "MOVED" && symbol.previous_file === "src/payments/service.ts" && symbol.file === "src/billing/service.ts",
    )).toBe(true);

    const html = await readFile(result.htmlPath, "utf8");
    expect(html).toContain("Show changed only");
    expect(html).toContain("Show changed + impacted");
    expect(html).toContain("Show full architecture");
    expect(html).toContain("Source diff");
    expect(html).toContain("Structural diff");
    expect(html).toContain("Related tests");
    expect(html).toContain("Review findings");
    expect(html).toContain("UNCHANGED");
    expect(html).toContain("IMPACTED");
  }, 60_000);

  it("builds and incrementally refreshes a normal directory without Git", async () => {
    const root = await filesystemFixture();

    const first = await buildRepository(root);
    const firstAtlas = JSON.parse(
      await readFile(path.join(first.currentDirectory, "atlas.json"), "utf8"),
    ) as Atlas;
    expect(validateAtlas(firstAtlas)).toEqual({ valid: true, errors: [] });
    expect(firstAtlas.project.git_commit).toBeNull();
    expect(firstAtlas.project.git_branch).toBeNull();
    expect(firstAtlas.git_changes).toEqual([]);
    expect(first.snapshotId).toMatch(/^worktree-[0-9a-f]{16}$/u);
    const buildMetadata = JSON.parse(
      await readFile(path.join(first.currentDirectory, "build.json"), "utf8"),
    ) as { git_available?: boolean; git_base?: string | null; git_head?: string | null };
    expect(buildMetadata).toMatchObject({
      git_available: false,
      git_base: null,
      git_head: null,
    });
    const status = statusPacket(await ensureFreshIndex(root));
    expect(status.freshness).toMatchObject({ git_available: false, head_commit: null });
    expect(status.facts.some((fact) => fact.evidence.file === ".git/HEAD")).toBe(false);
    expect(status.facts.some((fact) => fact.statement.includes("filesystem mode"))).toBe(true);

    const unchanged = await buildRepository(root);
    expect(unchanged.parsedFiles).toBe(0);
    expect(unchanged.reusedFiles).toBe(first.statistics.files);

    const servicePath = path.join(root, "src", "auth", "service.ts");
    const service = await readFile(servicePath, "utf8");
    await writeFile(
      servicePath,
      service.replace(
        'return password.length > 7 ? "token" : "unauthorized";',
        'return password.length > 10 ? "token" : "unauthorized";',
      ),
      "utf8",
    );
    const modified = await buildRepository(root);
    expect(modified.parsedFiles).toBe(1);

    const removedPath = path.join(root, "src", "admin", "service.ts");
    await rm(removedPath, { force: true });
    const afterDelete = await buildRepository(root);
    const finalAtlas = JSON.parse(
      await readFile(path.join(afterDelete.currentDirectory, "atlas.json"), "utf8"),
    ) as Atlas;
    expect(validateAtlas(finalAtlas)).toEqual({ valid: true, errors: [] });
    expect(finalAtlas.symbols.some((symbol) => symbol.file === "src/admin/service.ts")).toBe(false);
    expect(finalAtlas.relationships.every((relationship) =>
      finalAtlas.symbols.some((symbol) => symbol.id === relationship.source) &&
      finalAtlas.symbols.some((symbol) => symbol.id === relationship.target),
    )).toBe(true);
  }, 60_000);
});
