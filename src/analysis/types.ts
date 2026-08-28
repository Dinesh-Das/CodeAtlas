import type { SourceType } from "../graph/types.js";

export interface AnalysisNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string | null;
  filePath: string | null;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  confidence: number;
  sourceType: SourceType;
}

export interface DependencyLink {
  id: string;
  sourceFile: string;
  targetFile: string;
  edgeType: string;
  filePath: string;
  line: number;
  confidence: number;
  sourceType: SourceType;
}

export interface FileGraph {
  fileNodes: Map<string, AnalysisNode>;
  nodes: AnalysisNode[];
  links: DependencyLink[];
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, Set<string>>;
}

export interface ArchitectureMetric {
  fileNodeId: string;
  filePath: string;
  fanIn: number;
  fanOut: number;
  dependencyDepth: number;
  crossDomainDependencies: number;
  lineCount: number;
  recentCommitCount: number;
  recentChurn: number;
  contributorCount: number;
  hotspotScore: number;
  lastModifiedCommit: string | null;
  lastModifiedDate: string | null;
  metadata: Record<string, unknown>;
}

export interface ArchitectureFinding {
  id: string;
  findingType: string;
  severity: "low" | "medium" | "high";
  title: string;
  filePath: string;
  line: number;
  sourceType: SourceType;
  confidence: number;
  evidenceNodeIds: string[];
  metadata: Record<string, unknown>;
}

export interface CommunityMembership {
  communityId: string;
  nodeId: string;
  filePath: string;
  memberCount: number;
}

export interface ArchitectureAnalysisResult {
  features: number;
  domains: number;
  communities: number;
  cycles: number;
  hotspots: number;
  findings: number;
  timingsMs: {
    graphLoading: number;
    communityDetection: number;
    domainFeatureAnalysis: number;
    cycleDetection: number;
    hotspotAnalysis: number;
    persistence: number;
    total: number;
  };
}
