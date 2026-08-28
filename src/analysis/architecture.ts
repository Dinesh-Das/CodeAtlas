import type { CodeAtlasConfig } from "../core/config.js";
import { performance } from "node:perf_hooks";
import type { FileHistorySummary } from "../git/history.js";
import type { AtlasDatabase } from "../storage/database.js";
import { removeStaleAnalysisNodes, replaceArchitectureData } from "../storage/analysis.js";
import { upsertEdge } from "../storage/edges.js";
import { upsertNode } from "../storage/nodes.js";
import { setRepositoryStates } from "../storage/state.js";
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
  structuralGeneration?: number,
): ArchitectureAnalysisResult {
  const totalStartedAt = performance.now();
  const graphStartedAt = performance.now();
  const graph = loadFileGraph(database);
  const graphLoading = performance.now() - graphStartedAt;
  const communitiesStartedAt = performance.now();
  const communities = findDependencyCommunities(repositoryId, graph);
  const communityDetection = performance.now() - communitiesStartedAt;
  const groupingStartedAt = performance.now();
  const grouping = buildGroupingArtifacts(
    repositoryId,
    graph,
    config,
    communities,
  );
  const domainFeatureAnalysis = performance.now() - groupingStartedAt;
  const cyclesStartedAt = performance.now();
  const cycles = config.analysis.technicalDebt
    ? findDependencyCycles(repositoryId, graph)
    : [];
  const cycleDetection = performance.now() - cyclesStartedAt;
  const hotspotsStartedAt = performance.now();
  const signals = calculateArchitectureSignals(
    repositoryId,
    graph,
    grouping.domainByFile,
    history,
    config,
  );
  const hotspotAnalysis = performance.now() - hotspotsStartedAt;
  const findings = [...cycles, ...signals.findings].sort((left, right) =>
    `${left.findingType}\0${left.filePath}\0${left.line}`.localeCompare(
      `${right.findingType}\0${right.filePath}\0${right.line}`,
    ),
  );
  const resultBase = {
    features: grouping.features,
    domains: grouping.domains,
    communities: new Set(communities.map((membership) => membership.communityId)).size,
    cycles: cycles.length,
    hotspots: findings.filter((finding) => finding.findingType === "change_hotspot").length,
    findings: findings.length,
  };
  let persistence = 0;
  const persist = database.transaction(() => {
    removeStaleAnalysisNodes(
      database,
      new Set(grouping.nodes.map((node) => node.id)),
    );
    for (const node of grouping.nodes) upsertNode(database, node, timestamp);
    for (const edge of grouping.edges) upsertEdge(database, edge, timestamp);
    replaceArchitectureData(database, signals.metrics, findings, communities, timestamp);
    if (structuralGeneration !== undefined) {
      setRepositoryStates(database, {
        architecture_generation: String(structuralGeneration),
        architecture_status: "current",
        architecture_summary: JSON.stringify(resultBase),
      });
    }
  });
  const persistenceStartedAt = performance.now();
  persist();
  persistence = performance.now() - persistenceStartedAt;
  return {
    ...resultBase,
    timingsMs: {
      graphLoading,
      communityDetection,
      domainFeatureAnalysis,
      cycleDetection,
      hotspotAnalysis,
      persistence,
      total: performance.now() - totalStartedAt,
    },
  };
}
