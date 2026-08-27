import { sha256 } from "../core/hashing.js";
import type { CodeAtlasConfig } from "../core/config.js";
import type { FileHistorySummary } from "../git/history.js";
import type {
  AnalysisNode,
  ArchitectureFinding,
  ArchitectureMetric,
  FileGraph,
} from "./types.js";

function dependencyDepth(graph: FileGraph, start: string, maxDepth: number): number {
  const visited = new Set([start]);
  let frontier = [start];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const filePath of frontier) {
      for (const target of graph.outgoing.get(filePath) ?? []) {
        if (visited.has(target)) continue;
        visited.add(target);
        next.push(target);
      }
    }
    if (next.length === 0) break;
    frontier = next;
    depth += 1;
  }
  return depth;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

function finding(
  repositoryId: string,
  input: Omit<ArchitectureFinding, "id">,
): ArchitectureFinding {
  return {
    ...input,
    id: sha256(
      `${repositoryId}:finding:${input.findingType}:${input.filePath}:${input.line}:${input.title}`,
    ),
  };
}

function evidenceMetadata(
  sourceType: "heuristic" | "git",
  filePath: string,
  line: number,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    evidence: { source_type: sourceType, file: filePath, line, column: 0 },
    ...metadata,
  };
}

function lineCountByFile(graph: FileGraph): Map<string, number> {
  const result = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.filePath === null) continue;
    result.set(node.filePath, Math.max(result.get(node.filePath) ?? 1, node.endLine ?? 1));
  }
  return result;
}

export function calculateArchitectureSignals(
  repositoryId: string,
  graph: FileGraph,
  domainByFile: ReadonlyMap<string, string>,
  history: ReadonlyMap<string, FileHistorySummary>,
  config: CodeAtlasConfig,
): { metrics: ArchitectureMetric[]; findings: ArchitectureFinding[] } {
  const lines = lineCountByFile(graph);
  const raw = [...graph.fileNodes].map(([filePath, fileNode]) => {
    const fanIn = graph.incoming.get(filePath)?.size ?? 0;
    const fanOut = graph.outgoing.get(filePath)?.size ?? 0;
    const fileHistory = history.get(filePath);
    const crossDomainDependencies = [...(graph.outgoing.get(filePath) ?? [])].filter(
      (target) => domainByFile.get(target) !== domainByFile.get(filePath),
    ).length;
    const recentChurn = fileHistory?.recentChurn ?? 0;
    const connectivity = fanIn + fanOut;
    return {
      fileNode,
      filePath,
      fanIn,
      fanOut,
      connectivity,
      crossDomainDependencies,
      dependencyDepth: dependencyDepth(
        graph,
        filePath,
        config.limits.maxTraversalDepth,
      ),
      lineCount: lines.get(filePath) ?? 1,
      recentCommitCount: fileHistory?.recentCommitCount ?? 0,
      recentChurn,
      contributorCount: fileHistory?.contributorCount ?? 0,
      lastModifiedCommit: fileHistory?.lastModifiedCommit ?? null,
      lastModifiedDate: fileHistory?.lastModifiedDate ?? null,
      hotspotScore:
        Math.round(connectivity * Math.log2(recentChurn + 2) * 100) / 100,
    };
  });
  const connectivityThreshold = Math.max(
    2,
    percentile(raw.map((metric) => metric.connectivity), 0.75),
  );
  const positiveChurn = raw
    .map((metric) => metric.recentChurn)
    .filter((value) => value > 0);
  const churnThreshold = Math.max(1, percentile(positiveChurn, 0.75));
  const metrics: ArchitectureMetric[] = raw.map((metric) => ({
    fileNodeId: metric.fileNode.id,
    filePath: metric.filePath,
    fanIn: metric.fanIn,
    fanOut: metric.fanOut,
    dependencyDepth: metric.dependencyDepth,
    crossDomainDependencies: metric.crossDomainDependencies,
    lineCount: metric.lineCount,
    recentCommitCount: metric.recentCommitCount,
    recentChurn: metric.recentChurn,
    contributorCount: metric.contributorCount,
    hotspotScore: metric.hotspotScore,
    lastModifiedCommit: metric.lastModifiedCommit,
    lastModifiedDate: metric.lastModifiedDate,
    metadata: {
      evidence: {
        source_type: history.has(metric.filePath) ? "git" : "heuristic",
        file: metric.filePath,
        line: 1,
        column: 0,
      },
      connectivity: metric.connectivity,
      domain: domainByFile.get(metric.filePath) ?? "root",
      churn_window_days: 90,
      history_commit_limit: 500,
    },
  }));

  if (!config.analysis.technicalDebt) return { metrics, findings: [] };
  const findings: ArchitectureFinding[] = [];
  for (const metric of raw) {
    if (metric.fanIn >= config.limits.highFanIn) {
      findings.push(
        finding(repositoryId, {
          findingType: "high_fan_in",
          severity: metric.fanIn >= config.limits.highFanIn * 2 ? "high" : "medium",
          title: `${metric.filePath} has fan-in ${metric.fanIn}`,
          filePath: metric.filePath,
          line: 1,
          sourceType: "heuristic",
          confidence: 0.9,
          evidenceNodeIds: [metric.fileNode.id],
          metadata: evidenceMetadata("heuristic", metric.filePath, 1, {
            signal: "high_fan_in",
            fan_in: metric.fanIn,
            threshold: config.limits.highFanIn,
          }),
        }),
      );
    }
    if (metric.fanOut >= config.limits.highFanOut) {
      findings.push(
        finding(repositoryId, {
          findingType: "high_fan_out",
          severity: metric.fanOut >= config.limits.highFanOut * 2 ? "high" : "medium",
          title: `${metric.filePath} has fan-out ${metric.fanOut}`,
          filePath: metric.filePath,
          line: 1,
          sourceType: "heuristic",
          confidence: 0.9,
          evidenceNodeIds: [metric.fileNode.id],
          metadata: evidenceMetadata("heuristic", metric.filePath, 1, {
            signal: "high_fan_out",
            fan_out: metric.fanOut,
            threshold: config.limits.highFanOut,
          }),
        }),
      );
    }
    if (metric.lineCount >= config.limits.largeFileLines) {
      findings.push(
        finding(repositoryId, {
          findingType: "large_file",
          severity: metric.lineCount >= config.limits.largeFileLines * 2 ? "high" : "medium",
          title: `${metric.filePath} spans approximately ${metric.lineCount} lines`,
          filePath: metric.filePath,
          line: 1,
          sourceType: "heuristic",
          confidence: 0.95,
          evidenceNodeIds: [metric.fileNode.id],
          metadata: evidenceMetadata("heuristic", metric.filePath, 1, {
            signal: "large_file",
            line_count: metric.lineCount,
            threshold: config.limits.largeFileLines,
          }),
        }),
      );
    }
    if (
      history.has(metric.filePath) &&
      metric.connectivity >= connectivityThreshold &&
      metric.recentChurn >= churnThreshold
    ) {
      findings.push(
        finding(repositoryId, {
          findingType: "change_hotspot",
          severity: metric.hotspotScore >= connectivityThreshold * 8 ? "high" : "medium",
          title: `${metric.filePath} combines elevated churn and connectivity`,
          filePath: metric.filePath,
          line: 1,
          sourceType: "git",
          confidence: 0.9,
          evidenceNodeIds: [metric.fileNode.id],
          metadata: evidenceMetadata("git", metric.filePath, 1, {
            signal: "change_hotspot",
            recent_churn: metric.recentChurn,
            connectivity: metric.connectivity,
            hotspot_score: metric.hotspotScore,
            churn_threshold: churnThreshold,
            connectivity_threshold: connectivityThreshold,
          }),
        }),
      );
    }
  }

  for (const node of graph.nodes) {
    if (
      node.filePath === null ||
      node.startLine === null ||
      node.endLine === null ||
      !["class", "function", "method"].includes(node.kind)
    ) {
      continue;
    }
    const symbolLines = node.endLine - node.startLine + 1;
    if (symbolLines < config.limits.largeSymbolLines) continue;
    findings.push(
      finding(repositoryId, {
        findingType: "large_symbol",
        severity: symbolLines >= config.limits.largeSymbolLines * 2 ? "high" : "medium",
        title: `${node.kind} ${node.qualifiedName ?? node.name} spans ${symbolLines} lines`,
        filePath: node.filePath,
        line: node.startLine,
        sourceType: "heuristic",
        confidence: 0.95,
        evidenceNodeIds: [node.id],
        metadata: evidenceMetadata("heuristic", node.filePath, node.startLine, {
          signal: "large_symbol",
          symbol_kind: node.kind,
          line_count: symbolLines,
          threshold: config.limits.largeSymbolLines,
        }),
      }),
    );
  }
  return { metrics, findings };
}
