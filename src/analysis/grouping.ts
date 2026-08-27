import path from "node:path";
import type { CodeAtlasConfig } from "../core/config.js";
import { createEdgeId, createNodeId } from "../graph/ids.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { AnalysisNode, FileGraph } from "./types.js";
import type { CommunityMembership } from "./types.js";

const SOURCE_ROOTS = new Set([
  "app",
  "apps",
  "lib",
  "libs",
  "packages",
  "server",
  "services",
  "src",
]);
const GENERIC_FEATURES = new Set([
  "common",
  "components",
  "core",
  "fixtures",
  "helpers",
  "root",
  "shared",
  "test",
  "tests",
  "utils",
]);
const SEMANTIC_KINDS = new Set([
  "api_route",
  "class",
  "database_model",
  "function",
  "interface",
  "method",
]);

export interface GroupingArtifacts {
  nodes: GraphNode[];
  edges: GraphEdge[];
  domainByFile: Map<string, string>;
  features: number;
  domains: number;
}

interface FeatureSignal {
  signal: string;
  file: string;
  line: number;
  weight: number;
  detail: string;
}

function groupKey(filePath: string): string {
  const directoryParts = path.posix.dirname(filePath).split("/").filter(Boolean);
  if (directoryParts.length === 0) return "root";
  let index = 0;
  while (index < directoryParts.length && SOURCE_ROOTS.has(directoryParts[index]!)) {
    index += 1;
  }
  return (directoryParts[index] ?? "root").toLowerCase();
}

function titleCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function pathPatternMatches(filePath: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${expression}$`, "iu").test(filePath);
}

function matchesOverride(
  filePath: string,
  override: CodeAtlasConfig["analysis"]["featureOverrides"][number],
): boolean {
  return (
    override.include.some((pattern) => pathPatternMatches(filePath, pattern)) &&
    !override.exclude.some((pattern) => pathPatternMatches(filePath, pattern))
  );
}

function featureSignals(
  key: string,
  files: readonly AnalysisNode[],
  semanticMembers: readonly AnalysisNode[],
  graph: FileGraph,
  communityByFile: ReadonlyMap<string, string>,
): FeatureSignal[] {
  const representative = files[0]!;
  const filePaths = new Set(files.flatMap((file) => (file.filePath === null ? [] : [file.filePath])));
  const signals: FeatureSignal[] = [
    {
      signal: "directory_structure",
      file: representative.filePath ?? ".",
      line: representative.startLine ?? 1,
      weight: 0.35,
      detail: `directory boundary ${key}`,
    },
  ];
  if (files.length > 1) {
    signals.push({
      signal: "directory_cluster",
      file: representative.filePath ?? ".",
      line: 1,
      weight: 0.1,
      detail: `${files.length} files share the boundary`,
    });
  }
  const normalizedKey = key.replace(/[-_\s]+/gu, "").toLowerCase();
  const named = semanticMembers.find((node) =>
    node.name.replace(/[-_\s]+/gu, "").toLowerCase().includes(normalizedKey),
  );
  if (named !== undefined && normalizedKey.length > 2) {
    signals.push({
      signal: "symbol_name",
      file: named.filePath ?? representative.filePath ?? ".",
      line: named.startLine ?? 1,
      weight: 0.1,
      detail: `symbol ${named.name} matches the feature vocabulary`,
    });
  }
  const route = semanticMembers.find((node) => node.kind === "api_route");
  if (route !== undefined) {
    signals.push({
      signal: "route",
      file: route.filePath ?? ".",
      line: route.startLine ?? 1,
      weight: 0.15,
      detail: "framework route entrypoint",
    });
  }
  const model = semanticMembers.find((node) => node.kind === "database_model");
  if (model !== undefined) {
    signals.push({
      signal: "database_model",
      file: model.filePath ?? ".",
      line: model.startLine ?? 1,
      weight: 0.15,
      detail: "database model in the same boundary",
    });
  }
  const test = files.find((file) =>
    /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[^.]+$/iu.test(file.filePath ?? ""),
  );
  if (test !== undefined) {
    signals.push({
      signal: "test_coverage",
      file: test.filePath ?? ".",
      line: 1,
      weight: 0.1,
      detail: "co-located test evidence",
    });
  }
  const dependency = graph.links.find(
    (link) => filePaths.has(link.sourceFile) && filePaths.has(link.targetFile),
  );
  if (dependency !== undefined) {
    signals.push({
      signal: "imports",
      file: dependency.filePath,
      line: dependency.line,
      weight: 0.1,
      detail: "internal dependency cohesion",
    });
  }
  const communityCounts = new Map<string, number>();
  for (const file of filePaths) {
    const community = communityByFile.get(file);
    if (community !== undefined) {
      communityCounts.set(community, (communityCounts.get(community) ?? 0) + 1);
    }
  }
  const dominantCommunity = [...communityCounts].sort((left, right) => right[1] - left[1])[0];
  if (dominantCommunity !== undefined && dominantCommunity[1] / files.length >= 0.6) {
    signals.push({
      signal: "graph_community",
      file: representative.filePath ?? ".",
      line: 1,
      weight: 0.1,
      detail: `${dominantCommunity[1]} files share dependency community ${dominantCommunity[0].slice(0, 8)}`,
    });
  }
  return signals;
}

function evidenceFor(node: AnalysisNode): {
  source_type: "heuristic";
  file: string;
  line: number;
  column: number;
} {
  return {
    source_type: "heuristic",
    file: node.filePath ?? ".",
    line: node.startLine ?? 1,
    column: node.startColumn ?? 0,
  };
}

function groupingNode(
  repositoryId: string,
  kind: "feature" | "domain",
  key: string,
  representative: AnalysisNode,
  confidence: number,
  metadata: Record<string, unknown>,
): GraphNode {
  const qualifiedName = `${kind}:${key}`;
  return {
    id: createNodeId(repositoryId, kind, ".", qualifiedName),
    kind,
    name: titleCase(key),
    qualifiedName,
    filePath: representative.filePath,
    language: null,
    startLine: representative.startLine ?? 1,
    startColumn: representative.startColumn ?? 0,
    endLine: representative.startLine ?? 1,
    endColumn: representative.startColumn ?? 0,
    signature: null,
    visibility: null,
    contentHash: null,
    sourceType: "heuristic",
    provenance: "inferred",
    confidence,
    metadata: {
      evidence: evidenceFor(representative),
      grouping_key: key,
      ...metadata,
    },
  };
}

function membershipEdge(
  repositoryId: string,
  edgeType: "BELONGS_TO_FEATURE" | "BELONGS_TO_DOMAIN",
  member: AnalysisNode,
  group: GraphNode,
  confidence: number,
): GraphEdge {
  const filePath = member.filePath ?? group.filePath ?? ".";
  const line = member.startLine ?? 1;
  return {
    id: createEdgeId(repositoryId, edgeType, member.id, group.id, filePath, line),
    sourceNodeId: member.id,
    targetNodeId: group.id,
    edgeType,
    sourceType: "heuristic",
    provenance: "inferred",
    confidence,
    filePath,
    line,
    metadata: {
      evidence: {
        source_type: "heuristic",
        file: filePath,
        line,
        column: member.startColumn ?? 0,
      },
      signal: "directory_and_dependency_grouping",
    },
  };
}

export function buildGroupingArtifacts(
  repositoryId: string,
  graph: FileGraph,
  config: CodeAtlasConfig,
  communities: readonly CommunityMembership[],
): GroupingArtifacts {
  const groups = new Map<string, AnalysisNode[]>();
  const domainByFile = new Map<string, string>();
  for (const [filePath, fileNode] of graph.fileNodes) {
    const key = groupKey(filePath);
    domainByFile.set(filePath, key);
    const members = groups.get(key) ?? [];
    members.push(fileNode);
    groups.set(key, members);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const communityByFile = new Map(
    communities.map((membership) => [membership.filePath, membership.communityId]),
  );
  const manuallyGroupedFiles = new Set<string>();
  if (config.analysis.featureDetection) {
    for (const override of config.analysis.featureOverrides) {
      const files = [...graph.fileNodes]
        .filter(([filePath]) => matchesOverride(filePath, override))
        .map(([, file]) => file)
        .sort((left, right) => (left.filePath ?? "").localeCompare(right.filePath ?? ""));
      if (files.length === 0) continue;
      for (const file of files) {
        if (file.filePath !== null) manuallyGroupedFiles.add(file.filePath);
      }
      const key = `manual:${override.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
      const feature = groupingNode(
        repositoryId,
        "feature",
        key,
        files[0]!,
        override.confidence,
        {
          evidence: {
            source_type: "config",
            file: ".codeatlas/config.json",
            line: 1,
            column: 0,
          },
          signal: "manual_override",
          supporting_evidence: override.include.map((pattern) => ({
            signal: "configuration_override",
            file: ".codeatlas/config.json",
            line: 1,
            weight: override.confidence,
            detail: pattern,
          })),
          member_file_count: files.length,
        },
      );
      feature.name = override.name;
      feature.sourceType = "config";
      feature.provenance = "verified";
      nodes.push(feature);
      for (const file of files) {
        const edge = membershipEdge(
          repositoryId,
          "BELONGS_TO_FEATURE",
          file,
          feature,
          override.confidence,
        );
        edge.sourceType = "config";
        edge.provenance = "verified";
        edge.metadata.signal = "manual_override";
        edge.metadata.evidence = {
          source_type: "config",
          file: ".codeatlas/config.json",
          line: 1,
          column: 0,
        };
        edges.push(edge);
      }
    }
  }
  let features = 0;
  for (const [key, files] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    files.sort((left, right) => (left.filePath ?? "").localeCompare(right.filePath ?? ""));
    const representative = files[0]!;
    const domainConfidence = files.length > 1 ? 0.85 : 0.7;
    const domain = groupingNode(
      repositoryId,
      "domain",
      key,
      representative,
      domainConfidence,
      {
        signal: "directory_boundary",
        member_file_count: files.length,
        member_files: files.map((file) => file.filePath),
      },
    );
    nodes.push(domain);
    for (const file of files) {
      edges.push(
        membershipEdge(
          repositoryId,
          "BELONGS_TO_DOMAIN",
          file,
          domain,
          domainConfidence,
        ),
      );
    }

    if (!config.analysis.featureDetection || GENERIC_FEATURES.has(key)) continue;
    const filePaths = new Set(files.map((file) => file.filePath));
    const semanticMembers = graph.nodes.filter(
      (node) =>
        node.filePath !== null &&
        !manuallyGroupedFiles.has(node.filePath) &&
        filePaths.has(node.filePath) &&
        SEMANTIC_KINDS.has(node.kind),
    );
    if (semanticMembers.length === 0) continue;
    const automaticFiles = files.filter(
      (file) => file.filePath === null || !manuallyGroupedFiles.has(file.filePath),
    );
    if (automaticFiles.length === 0) continue;
    const hasEntrypoint = semanticMembers.some((node) => node.kind === "api_route");
    const hasModel = semanticMembers.some((node) => node.kind === "database_model");
    const signals = featureSignals(
      key,
      automaticFiles,
      semanticMembers,
      graph,
      communityByFile,
    );
    const confidence = Math.min(
      0.95,
      Number(signals.reduce((sum, signal) => sum + signal.weight, 0).toFixed(2)),
    );
    const feature = groupingNode(
      repositoryId,
      "feature",
      key,
      automaticFiles[0]!,
      confidence,
      {
        signal: "directory_semantic_cluster",
        member_file_count: files.length,
        semantic_member_count: semanticMembers.length,
        has_api_route: hasEntrypoint,
        has_database_model: hasModel,
        supporting_evidence: signals,
      },
    );
    nodes.push(feature);
    features += 1;
    const members = new Map(
      [...automaticFiles, ...semanticMembers].map((member) => [member.id, member]),
    );
    for (const member of members.values()) {
      edges.push(
        membershipEdge(
          repositoryId,
          "BELONGS_TO_FEATURE",
          member,
          feature,
          confidence,
        ),
      );
    }
  }
  features += config.analysis.featureOverrides.filter((override) =>
    [...graph.fileNodes.keys()].some((filePath) => matchesOverride(filePath, override)),
  ).length;
  return { nodes, edges, domainByFile, features, domains: groups.size };
}
