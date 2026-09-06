import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepository } from "../../src/compiler/build.js";
import {
  evidenceRejectionReason,
  validateEvidenceIds,
} from "../../src/ir/evidence-validation.js";
import type { Atlas, AtlasControlFlow } from "../../src/ir/models.js";
import { findSymbolIr, symbolIr } from "../../src/mcp/ir-tools.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

function pathsToEnd(flow: AtlasControlFlow): string[][] {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of flow.edges) {
    if (edge.source === edge.target) continue;
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const start = flow.nodes.find((node) => node.kind === "START")!;
  const end = flow.nodes.find((node) => node.kind === "END")!;
  const result: string[][] = [];
  const visit = (id: string, pathIds: string[]): void => {
    if (pathIds.includes(id)) return;
    const nextPath = [...pathIds, id];
    if (id === end.id) {
      result.push(nextPath.map((nodeId) => byId.get(nodeId)?.label ?? nodeId));
      return;
    }
    for (const target of outgoing.get(id) ?? []) visit(target, nextPath);
  };
  visit(start.id, []);
  return result;
}

async function reliabilityFixture(): Promise<{ atlas: Atlas; repository: TestRepository }> {
  const repository = await createTestRepository();
  repositories.push(repository);
  await repository.write("package.json", `${JSON.stringify({ name: "reliability-fixture", type: "module" })}\n`);
  await repository.write(
    "src/probes.ts",
    [
      "export function callBeforeReturn(): number {",
      "  return calculate();",
      "}",
      "function calculate(): number { return 1; }",
      "export function choose(flag: boolean): void {",
      "  if (flag) { left(); } else { right(); }",
      "  done();",
      "}",
      "function left(): void {}",
      "function right(): void {}",
      "function done(): void {}",
      "export function cleanup(): number {",
      "  try { return calculate(); } finally { done(); }",
      "}",
      "export function unsupported(flag: boolean): number {",
      "  return flag ? 1 : 2;",
      "}",
      "",
    ].join("\n"),
  );
  await repository.write("src/first.ts", "export function login(): string { return 'first'; }\n");
  await repository.write("src/second.ts", "export function login(): string { return 'second'; }\n");
  await repository.git("add", ".");
  await repository.git("commit", "-m", "reliability fixture");
  const build = await buildRepository(repository.root, { snapshot: false });
  const atlas = JSON.parse(
    await readFile(path.join(build.currentDirectory, "atlas.json"), "utf8"),
  ) as Atlas;
  return { atlas, repository };
}

describe("audited reliability regressions", () => {
  it("preserves expression, branch, and finally execution order with grounded evidence", async () => {
    const { atlas } = await reliabilityFixture();
    const flowFor = (name: string): AtlasControlFlow => {
      const symbol = atlas.symbols.find((candidate) =>
        candidate.kind === "function" && candidate.name === name && candidate.file === "src/probes.ts"
      )!;
      return atlas.control_flows.find((flow) => flow.symbol_id === symbol.id)!;
    };

    const returnFlow = flowFor("callBeforeReturn");
    expect(pathsToEnd(returnFlow)).toEqual([
      expect.arrayContaining(["calculate()", "return calculate();"]),
    ]);
    const returnPath = pathsToEnd(returnFlow)[0]!;
    expect(returnPath.indexOf("calculate()")).toBeLessThan(returnPath.indexOf("return calculate();"));

    const branchPaths = pathsToEnd(flowFor("choose"));
    expect(branchPaths).toHaveLength(2);
    expect(branchPaths).toContainEqual(expect.arrayContaining(["left()", "done()"]));
    expect(branchPaths).toContainEqual(expect.arrayContaining(["right()", "done()"]));
    expect(branchPaths.every((flow) => !(flow.includes("left()") && flow.includes("right()"))))
      .toBe(true);

    const cleanupPaths = pathsToEnd(flowFor("cleanup"));
    expect(cleanupPaths.length).toBeGreaterThan(0);
    expect(cleanupPaths.every((flow) =>
      flow.some((label) => label.startsWith("finally")) && flow.includes("done()")
    )).toBe(true);

    for (const flow of [returnFlow, flowFor("choose"), flowFor("cleanup")]) {
      expect(flow.analysis_kind).toBe("structured_ast_approximation");
      const evidenceIds = flow.nodes.flatMap((node) => node.evidence_ids);
      expect(validateEvidenceIds(atlas, evidenceIds).rejected).toEqual([]);
      const statementEvidence = atlas.evidence.filter((evidence) =>
        evidenceIds.includes(evidence.id) && evidence.range_content_hash !== null
      );
      expect(statementEvidence.length).toBeGreaterThan(0);
      expect(statementEvidence.every((evidence) => evidence.file_content_hash !== undefined)).toBe(true);
      expect(statementEvidence.every((evidence) => evidence.excerpt_status === "complete")).toBe(true);
      expect(evidenceRejectionReason(atlas, {
        ...statementEvidence[0]!,
        file_content_hash: "0".repeat(64),
      })).toBe("evidence content hash does not match its symbol");
    }
    expect(flowFor("unsupported").unsupported_constructs).toContain("ternary_expression");
  });

  it("requires an exact stable ID when qualified names are duplicated", async () => {
    const { repository } = await reliabilityFixture();
    const matches = await findSymbolIr(repository.root, "login", 10);
    const functions = matches.results.filter((candidate) =>
      candidate.kind === "function" && candidate.qualified_name === "login"
    );
    expect(functions.map((candidate) => candidate.file).sort()).toEqual([
      "src/first.ts",
      "src/second.ts",
    ]);
    await expect(symbolIr(repository.root, "login"))
      .rejects.toThrow(/Ambiguous symbol: login.*Use an exact ID/u);
    await expect(symbolIr(repository.root, functions[0]!.id)).resolves.toMatchObject({
      symbol: { id: functions[0]!.id, file: functions[0]!.file },
    });
  });
});
