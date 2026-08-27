import path from "node:path";
import { createEdgeId, createNodeId } from "../graph/ids.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { AnalysisNode, FileGraph } from "./types.js";

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
  featureDetection: boolean,
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

    if (!featureDetection || GENERIC_FEATURES.has(key)) continue;
    const filePaths = new Set(files.map((file) => file.filePath));
    const semanticMembers = graph.nodes.filter(
      (node) =>
        node.filePath !== null &&
        filePaths.has(node.filePath) &&
        SEMANTIC_KINDS.has(node.kind),
    );
    if (semanticMembers.length === 0) continue;
    const hasEntrypoint = semanticMembers.some((node) => node.kind === "api_route");
    const hasModel = semanticMembers.some((node) => node.kind === "database_model");
    const confidence = Math.min(
      0.9,
      0.65 + (files.length > 1 ? 0.1 : 0) + (hasEntrypoint ? 0.05 : 0) + (hasModel ? 0.05 : 0),
    );
    const feature = groupingNode(
      repositoryId,
      "feature",
      key,
      representative,
      confidence,
      {
        signal: "directory_semantic_cluster",
        member_file_count: files.length,
        semantic_member_count: semanticMembers.length,
        has_api_route: hasEntrypoint,
        has_database_model: hasModel,
      },
    );
    nodes.push(feature);
    features += 1;
    const members = new Map(
      [...files, ...semanticMembers].map((member) => [member.id, member]),
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
  return { nodes, edges, domainByFile, features, domains: groups.size };
}
