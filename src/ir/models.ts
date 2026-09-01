import type { ArchitecturalScope } from "../analysis/scope.js";

export const ATLAS_SCHEMA_VERSION = "1.0" as const;

export const ATLAS_PROVENANCE = [
  "AST",
  "STATIC_ANALYSIS",
  "CONFIG",
  "GIT",
  "HEURISTIC",
  "EMBEDDING",
  "LLM",
  "USER_DEFINED",
] as const;

export type AtlasProvenance = (typeof ATLAS_PROVENANCE)[number];
export type AtlasFactClass = "EXTRACTED" | "RESOLVED" | "INFERRED";

export interface AtlasLocation {
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export interface AtlasProject {
  id: string;
  name: string;
  root: string;
  git_commit: string | null;
  git_branch: string | null;
  dirty: boolean;
}

export interface AtlasSymbol {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file: string | null;
  /** Added in 1.0 as a backwards-compatible field; older snapshots may omit it. */
  scope?: ArchitecturalScope;
  language: string | null;
  location: AtlasLocation | null;
  domain_ids: string[];
  visibility: string | null;
  signature: string | null;
  content_hash: string | null;
  confidence: number;
  provenance: AtlasProvenance;
  fact_class: AtlasFactClass;
  evidence_ids: string[];
  metadata: Record<string, unknown>;
}

export interface AtlasRelationship {
  id: string;
  source: string;
  target: string;
  type: string;
  confidence: number;
  provenance: AtlasProvenance;
  fact_class: AtlasFactClass;
  evidence_ids: string[];
  metadata: Record<string, unknown>;
}

export interface AtlasEvidence {
  id: string;
  file: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  symbol_id: string | null;
  relationship_id: string | null;
  kind: "source" | "config" | "git" | "documentation";
  excerpt: string | null;
  content_hash: string | null;
}

export interface AtlasDomain {
  id: string;
  name: string;
  member_ids: string[];
  file_ids: string[];
  entrypoint_ids: string[];
  internal_relationship_ids: string[];
  outgoing_relationship_ids: string[];
  confidence: number;
  label_provenance: AtlasProvenance;
  evidence_ids: string[];
}

export interface AtlasFlowStep {
  order: number;
  symbol_id: string;
  relationship_id: string | null;
  confidence: number;
  evidence_ids: string[];
}

export interface AtlasFlowEdge {
  id: string;
  source: string;
  target: string;
  relationship_id: string;
  confidence: number;
  evidence_ids: string[];
}

export interface AtlasFlowPath {
  id: string;
  symbol_ids: string[];
  relationship_ids: string[];
  truncated: boolean;
  cycle_detected: boolean;
}

export interface AtlasFlow {
  id: string;
  name: string;
  entrypoint_id: string;
  steps: AtlasFlowStep[];
  /** Branch-preserving execution graph. `steps` remains as a compatibility summary. */
  edges?: AtlasFlowEdge[];
  paths?: AtlasFlowPath[];
  truncated: boolean;
  cycle_detected: boolean;
}

export type ControlFlowNodeKind =
  | "START"
  | "STATEMENT"
  | "CALL"
  | "CONDITION"
  | "BRANCH"
  | "LOOP"
  | "TRY"
  | "CATCH"
  | "FINALLY"
  | "RETURN"
  | "RAISE"
  | "END";

export interface ControlFlowNode {
  id: string;
  kind: ControlFlowNodeKind;
  label: string;
  evidence_ids: string[];
}

export interface ControlFlowEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
}

export interface AtlasControlFlow {
  id: string;
  symbol_id: string;
  nodes: ControlFlowNode[];
  edges: ControlFlowEdge[];
  truncated: boolean;
}

export interface ImpactPath {
  changed: string;
  impacted: string;
  distance: number;
  path: string[];
  relationship_ids: string[];
  evidence_ids: string[];
  classification?: "definite" | "potential";
  confidence?: number;
}

export interface ImpactFactor {
  value: number;
  weight: number;
  contribution: number;
}

export interface ImpactScoreComponents {
  direct_callers: ImpactFactor;
  transitive_reach: ImpactFactor;
  affected_entrypoints: ImpactFactor;
  cross_domain: ImpactFactor;
  public_api: ImpactFactor;
  database_schema: ImpactFactor;
  missing_test_coverage: ImpactFactor;
  centrality: ImpactFactor;
  architecture_rules: ImpactFactor;
}

export interface ImpactResult {
  changed: string;
  direct_callers: string[];
  direct_dependents?: string[];
  direct_dependencies: string[];
  potential_direct_dependents?: string[];
  potential_direct_dependencies?: string[];
  transitive_callers: string[];
  transitive_dependencies: string[];
  affected_files: string[];
  affected_domains: string[];
  affected_entrypoints: string[];
  affected_apis: string[];
  affected_tests: string[];
  affected_rules: string[];
  paths: ImpactPath[];
  dependency_paths: ImpactPath[];
  potential_paths?: ImpactPath[];
  potential_dependency_paths?: ImpactPath[];
  score: ImpactScore | null;
}

export interface ImpactScore {
  symbol_id: string;
  score: number;
  risk: "low" | "medium" | "high";
  direct_callers: number;
  transitive_reach: number;
  affected_entrypoints: number;
  affected_domains: number;
  cross_domain: boolean;
  affected_apis: number;
  affected_tests: number;
  affected_rules: number;
  database_schema_impact: boolean;
  centrality: number;
  components: ImpactScoreComponents;
  reasons: string[];
}

export interface AtlasImpactIndex {
  forward: Record<string, string[]>;
  reverse: Record<string, string[]>;
  scores: ImpactScore[];
}

export type GitChangeStatus =
  | "ADDED"
  | "MODIFIED"
  | "DELETED"
  | "MOVED"
  | "IMPACTED"
  | "UNCHANGED";

export interface AtlasGitSymbolChange {
  status: Exclude<GitChangeStatus, "IMPACTED" | "UNCHANGED">;
  symbol_id: string | null;
  previous_symbol_id: string | null;
  name: string;
  qualified_name: string | null;
  kind: string;
  file: string;
  previous_file: string | null;
}

export interface AtlasGitChange {
  id: string;
  status: GitChangeStatus;
  file: string;
  previous_file: string | null;
  line_ranges: Array<{ start_line: number; end_line: number }>;
  symbol_ids: string[];
  symbol_changes: AtlasGitSymbolChange[];
  impacted_symbol_ids: string[];
  impact_paths: ImpactPath[];
  source_diff: string;
  related_test_ids: string[];
  rule_violation_ids: string[];
  review_finding_ids: string[];
  evidence_ids: string[];
}

export type RuleSeverity = "info" | "warning" | "error";

export interface ArchitectureRule {
  id: string;
  description: string;
  severity: RuleSeverity;
  source: Record<string, string>;
  forbid: Record<string, unknown>;
}

export interface RuleViolation {
  id: string;
  rule_id: string;
  severity: RuleSeverity;
  source_id: string;
  target_id: string | null;
  path: string[];
  relationship_ids: string[];
  evidence_ids: string[];
  message: string;
}

export interface ReviewFinding {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  category: string;
  title: string;
  description: string;
  changed_symbol_ids: string[];
  impacted_symbol_ids: string[];
  evidence_ids: string[];
  impact_paths: ImpactPath[];
  confidence: number;
  provenance: AtlasProvenance;
}

export interface AtlasStatistics {
  files: number;
  symbols: number;
  relationships: number;
  domains: number;
  entrypoints: number;
  flows: number;
  control_flows: number;
  rule_violations: number;
  review_findings: number;
}

export interface Atlas {
  schema_version: typeof ATLAS_SCHEMA_VERSION;
  generator: {
    name: "CodeAtlas";
    version: string;
    indexer_version: string;
  };
  project: AtlasProject;
  snapshot: {
    id: string;
    created_at: string;
  };
  symbols: AtlasSymbol[];
  relationships: AtlasRelationship[];
  evidence: AtlasEvidence[];
  domains: AtlasDomain[];
  entrypoint_ids: string[];
  flows: AtlasFlow[];
  control_flows: AtlasControlFlow[];
  impact: AtlasImpactIndex;
  git_changes: AtlasGitChange[];
  rules: ArchitectureRule[];
  rule_violations: RuleViolation[];
  review_findings: ReviewFinding[];
  statistics: AtlasStatistics;
}
