import { describe, expect, it } from "vitest";
import { findDependencyCommunities } from "../../src/analysis/communities.js";
import { findDependencyCycles } from "../../src/analysis/cycles.js";
import { buildGroupingArtifacts } from "../../src/analysis/grouping.js";
import type { AnalysisNode, DependencyLink, FileGraph } from "../../src/analysis/types.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";

function graph(paths: readonly string[], pairs: readonly (readonly [string, string])[]): FileGraph {
  const fileNodes = new Map<string, AnalysisNode>();
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const filePath of paths) {
    fileNodes.set(filePath, {
      id: `node:${filePath}`,
      kind: "file",
      name: filePath,
      qualifiedName: filePath,
      filePath,
      startLine: 1,
      startColumn: 0,
      endLine: 1,
      confidence: 1,
      sourceType: "ast",
    });
    outgoing.set(filePath, new Set());
    incoming.set(filePath, new Set());
  }
  const links: DependencyLink[] = pairs.map(([sourceFile, targetFile], index) => {
    outgoing.get(sourceFile)!.add(targetFile);
    incoming.get(targetFile)!.add(sourceFile);
    return {
      id: `edge:${index}`,
      sourceFile,
      targetFile,
      edgeType: "IMPORTS",
      filePath: sourceFile,
      line: 1,
      confidence: 1,
      sourceType: "ast",
    };
  });
  return { fileNodes, nodes: [...fileNodes.values()], links, outgoing, incoming };
}

describe("scalable architecture graph algorithms", () => {
  it("finds dense communities inside one connected component", () => {
    const left = ["a1.ts", "a2.ts", "a3.ts", "a4.ts"];
    const right = ["b1.ts", "b2.ts", "b3.ts", "b4.ts"];
    const clique = (members: readonly string[]) => members.flatMap((source, index) =>
      members.slice(index + 1).map((target) => [source, target] as const),
    );
    const memberships = findDependencyCommunities(
      "repository",
      graph([...left, ...right], [...clique(left), ...clique(right), ["a4.ts", "b1.ts"]]),
    );
    const communities = new Map<string, string[]>();
    for (const membership of memberships) {
      const members = communities.get(membership.communityId) ?? [];
      members.push(membership.filePath);
      communities.set(membership.communityId, members);
    }
    expect([...communities.values()].map((members) => members.sort())).toEqual([left, right]);
  });

  it("handles dependency chains deeper than the JavaScript call stack", () => {
    const paths = Array.from({ length: 20_000 }, (_, index) => `src/${index}.ts`);
    const pairs = paths.slice(0, -1).map((source, index) => [source, paths[index + 1]!] as const);
    pairs.push([paths.at(-1)!, paths[0]!] as const);
    const findings = findDependencyCycles("repository", graph(paths, pairs));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidenceNodeIds).toHaveLength(paths.length);
  });

  it("discovers one business feature across technical-layer directories", () => {
    const paths = [
      "controllers/checkout-controller.ts",
      "services/checkout-service.ts",
      "repositories/checkout-repository.ts",
    ];
    const layered = graph(paths, [
      [paths[0]!, paths[1]!],
      [paths[1]!, paths[2]!],
    ]);
    layered.nodes.push(...paths.map((filePath, index): AnalysisNode => ({
      id: `symbol:${index}`,
      kind: index === 0 ? "class" : "function",
      name: index === 0 ? "CheckoutController" : index === 1 ? "checkoutService" : "checkoutRepository",
      qualifiedName: null,
      filePath,
      startLine: 1,
      startColumn: 0,
      endLine: 2,
      confidence: 1,
      sourceType: "ast",
    })));
    const grouping = buildGroupingArtifacts("repository", layered, DEFAULT_CONFIG, []);
    const checkout = grouping.nodes.find((node) => node.kind === "feature" && node.name === "Checkout");
    expect(checkout).toBeDefined();
    expect(grouping.edges.filter((edge) =>
      edge.edgeType === "BELONGS_TO_FEATURE" &&
      edge.targetNodeId === checkout?.id &&
      edge.sourceNodeId.startsWith("node:"),
    ).map((edge) => edge.sourceNodeId).sort()).toEqual(
      paths.map((filePath) => `node:${filePath}`).sort(),
    );
  });
});
