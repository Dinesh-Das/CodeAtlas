import type { CodeAtlasConfig } from "../core/config.js";
import type { FileHistorySummary } from "../git/history.js";
import type { AtlasDatabase } from "../storage/database.js";
import { removeStaleAnalysisNodes, replaceArchitectureData } from "../storage/analysis.js";
import { upsertEdge } from "../storage/edges.js";
import { upsertNode } from "../storage/nodes.js";
import { findDependencyCommunities } from "./communities.js";
import { calculateArchitectureSignals } from "./coupling.js";
import { findDependencyCycles } from "./cycles.js";
import { loadFileGraph } from "./graph.js";
import { buildGroupingArtifacts } from "./grouping.js";
import type { ArchitectureAnalysisResult } from "./types.js";

export function runArchitectureAnalysis(
  database: AtlasDatabase,
  repositoryId: string,
  config: CodeAtlasConfig,
  history: ReadonlyMap<string, FileHistorySummary>,
  timestamp: string,
): ArchitectureAnalysisResult {
  const graph = loadFileGraph(database);
  const communities = findDependencyCommunities(repositoryId, graph);
  const grouping = buildGroupingArtifacts(
    repositoryId,
    graph,
    config,
    communities,
  );
  removeStaleAnalysisNodes(
    database,
    new Set(grouping.nodes.map((node) => node.id)),
  );
  for (const node of grouping.nodes) upsertNode(database, node, timestamp);
  for (const edge of grouping.edges) upsertEdge(database, edge, timestamp);

  const cycles = config.analysis.technicalDebt
    ? findDependencyCycles(repositoryId, graph)
    : [];
  const signals = calculateArchitectureSignals(
    repositoryId,
    graph,
    grouping.domainByFile,
    history,
    config,
  );
  const findings = [...cycles, ...signals.findings].sort((left, right) =>
    `${left.findingType}\0${left.filePath}\0${left.line}`.localeCompare(
      `${right.findingType}\0${right.filePath}\0${right.line}`,
    ),
  );
  replaceArchitectureData(database, signals.metrics, findings, communities, timestamp);

  return {
    features: grouping.features,
    domains: grouping.domains,
    communities: new Set(communities.map((membership) => membership.communityId)).size,
    cycles: cycles.length,
    hotspots: findings.filter((finding) => finding.findingType === "change_hotspot").length,
    findings: findings.length,
  };
}
