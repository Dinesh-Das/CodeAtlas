import { sha256 } from "../core/hashing.js";
import {
  classifyArchitecturalScope,
  isArchitecturalEntrypoint,
} from "../analysis/scope.js";
import type { AtlasDatabase } from "../storage/database.js";
import { CODEATLAS_VERSION, INDEXER_VERSION } from "../version.js";
import { createEvidenceId, EvidenceExcerptReader, evidenceKind } from "./evidence.js";
import {
  ATLAS_SCHEMA_VERSION,
  type Atlas,
  type AtlasDomain,
  type AtlasEvidence,
  type AtlasExecutionSemantics,
  type AtlasFactClass,
  type AtlasProvenance,
  type AtlasProvenanceCategory,
  type AtlasRelationship,
  type AtlasResolutionIssue,
  type AtlasSymbol,
  type AtlasTargetResolution,
} from "./models.js";
import { normalizeAtlas } from "./serialization.js";

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  language: string | null;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  signature: string | null;
  visibility: string | null;
  content_hash: string | null;
  source_type: string;
  provenance_category: string;
  confidence: number;
  metadata_json: string | null;
}

interface EdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  source_type: string;
  provenance_category: string;
  confidence: number;
  file_path: string | null;
  line: number | null;
  metadata_json: string | null;
  owner_kind: string;
}

interface ResolutionIssueRow {
  id: string;
  source_node_id: string;
  reference_kind: string;
  reference_name: string | null;
  reference_hash: string;
  file_path: string;
  line: number;
  column_number: number;
  reason: AtlasResolutionIssue["reason"];
  candidate_node_ids_json: string;
  metadata_json: string;
}

const EXECUTABLE_RELATIONSHIPS = new Set([
  "CALLS", "HANDLES", "TRIGGERS", "PUBLISHES", "SUBSCRIBES", "MAY_CONTINUE_TO",
  "APPLIES_HOOK", "PROTECTED_BY", "QUERIES", "UPDATES", "READS_FROM", "WRITES_TO",
]);

function parseMetadata(value: string | null): Record<string, unknown> {
  if (value === null || value === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function atlasProvenance(sourceType: string): AtlasProvenance {
  switch (sourceType) {
    case "ast": return "AST";
    case "compiler":
    case "framework":
    case "schema": return "STATIC_ANALYSIS";
    case "config": return "CONFIG";
    case "git": return "GIT";
    case "heuristic":
    case "documentation": return "HEURISTIC";
    default: return "STATIC_ANALYSIS";
  }
}

function provenanceCategory(value: string, sourceType: string): AtlasProvenanceCategory {
  if (["verified", "inferred", "dynamic", "documentation", "git", "unresolved"].includes(value)) {
    return value as AtlasProvenanceCategory;
  }
  if (sourceType === "heuristic") return "inferred";
  if (sourceType === "documentation") return "documentation";
  if (sourceType === "git") return "git";
  return "verified";
}

function targetResolution(
  metadata: Readonly<Record<string, unknown>>,
  provenance: AtlasProvenanceCategory,
  sourceType: string,
): AtlasTargetResolution {
  const resolution = metadata.resolution;
  if (resolution === "exact" || resolution === "unique_candidate" || resolution === "ambiguous") {
    return resolution;
  }
  if (provenance === "dynamic") return "dynamic";
  return sourceType === "heuristic" ? "unique_candidate" : "exact";
}

function executionSemantics(
  edgeType: string,
  metadata: Readonly<Record<string, unknown>>,
): AtlasExecutionSemantics {
  if (!EXECUTABLE_RELATIONSHIPS.has(edgeType)) return "not_applicable";
  if (metadata.conditional === true) return "conditional";
  if (metadata.conditional === false) return "unconditional";
  return "unknown";
}

function issueProvenance(reason: AtlasResolutionIssue["reason"]): AtlasProvenanceCategory {
  if (reason === "unresolved_reference" || reason === "unsupported_framework") return "unresolved";
  if (reason === "dynamic_relationship" || reason === "generated_code") return "dynamic";
  return "inferred";
}

function factClass(sourceType: string, ownerKind?: string): AtlasFactClass {
  if (sourceType === "heuristic" || sourceType === "documentation") return "INFERRED";
  if (ownerKind === "resolved" || ownerKind === "framework_projection" || ownerKind === "architecture_projection") {
    return "RESOLVED";
  }
  return "EXTRACTED";
}

function repositoryState(database: AtlasDatabase): Record<string, string> {
  return Object.fromEntries(
    (database.prepare("SELECT key, value FROM repository_state ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>).map((row) => [row.key, row.value]),
  );
}

function locatedNode(row: NodeRow): row is NodeRow & {
  file_path: string;
  start_line: number;
} {
  return row.file_path !== null && row.start_line !== null;
}

function domainProjection(
  symbols: AtlasSymbol[],
  relationships: AtlasRelationship[],
): AtlasDomain[] {
  const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const domainSymbols = symbols.filter((symbol) => symbol.kind === "domain");
  const memberships = relationships.filter((edge) => edge.type === "BELONGS_TO_DOMAIN");
  const domainByMember = new Map<string, string[]>();
  for (const membership of memberships) {
    const ids = domainByMember.get(membership.source) ?? [];
    ids.push(membership.target);
    domainByMember.set(membership.source, ids);
  }
  for (const symbol of symbols) symbol.domain_ids = domainByMember.get(symbol.id) ?? [];

  return domainSymbols.map((domain): AtlasDomain => {
    const domainMemberships = memberships.filter((edge) => edge.target === domain.id);
    const memberIds = domainMemberships.map((edge) => edge.source);
    const fileIds = memberIds.filter((id) => symbolById.get(id)?.kind === "file");
    const memberFiles = new Set(
      memberIds.map((id) => symbolById.get(id)?.file).filter((file): file is string => file !== null && file !== undefined),
    );
    const expandedMembers = new Set([
      ...memberIds,
      ...symbols.filter((symbol) => symbol.file !== null && memberFiles.has(symbol.file)).map((symbol) => symbol.id),
    ]);
    const entrypointIds = symbols
      .filter((symbol) => isArchitecturalEntrypoint(symbol) && expandedMembers.has(symbol.id))
      .map((symbol) => symbol.id);
    const internal = relationships.filter((edge) =>
      expandedMembers.has(edge.source) && expandedMembers.has(edge.target),
    );
    const outgoing = relationships.filter((edge) =>
      expandedMembers.has(edge.source) && !expandedMembers.has(edge.target) && edge.target !== domain.id,
    );
    const confidence = domainMemberships.length === 0
      ? domain.confidence
      : domainMemberships.reduce((total, edge) => total + edge.confidence, 0) / domainMemberships.length;
    return {
      id: domain.id,
      name: domain.name,
      member_ids: [...expandedMembers],
      file_ids: fileIds,
      entrypoint_ids: entrypointIds,
      internal_relationship_ids: internal.map((edge) => edge.id),
      outgoing_relationship_ids: outgoing.map((edge) => edge.id),
      confidence,
      label_provenance: domain.provenance,
      evidence_ids: domain.evidence_ids,
    };
  });
}

export async function loadAtlasFromDatabase(input: {
  database: AtlasDatabase;
  repositoryRoot: string;
  repositoryId: string;
  repositoryName: string;
  gitAvailable: boolean;
  headCommit: string;
  branch: string;
}): Promise<Atlas> {
  const state = repositoryState(input.database);
  const dirty = state.working_tree_dirty === "true";
  const fingerprint = state.dirty_fingerprint ?? sha256(input.headCommit);
  const snapshotId = !input.gitAvailable || dirty || input.headCommit === "unborn"
    ? `worktree-${fingerprint.slice(0, 16)}`
    : input.headCommit;
  const createdAt = state.last_indexed_at ?? new Date(0).toISOString();
  const nodeRows = input.database.prepare(
    `SELECT id, kind, name, qualified_name, file_path, language,
            start_line, start_column, end_line, end_column, signature, visibility,
            content_hash, source_type, provenance_category, confidence, metadata_json
     FROM nodes ORDER BY id`,
  ).all() as NodeRow[];
  const edgeRows = input.database.prepare(
    `SELECT id, source_node_id, target_node_id, edge_type, source_type,
            provenance_category, confidence, file_path, line, metadata_json, owner_kind
     FROM edges ORDER BY id`,
  ).all() as EdgeRow[];
  const resolutionIssueRows = input.database.prepare(
    `SELECT id, source_node_id, reference_kind, reference_name, reference_hash,
            file_path, line, column_number, reason, candidate_node_ids_json, metadata_json
     FROM resolution_issues ORDER BY file_path, line, column_number, id`,
  ).all() as ResolutionIssueRow[];
  const nodeIds = new Set(nodeRows.map((row) => row.id));
  const fileContentHashes = new Map<string, string>();
  for (const row of nodeRows) {
    if (row.file_path !== null && row.content_hash !== null) {
      fileContentHashes.set(row.file_path, row.content_hash);
    }
  }
  const excerptReader = new EvidenceExcerptReader(input.repositoryRoot);
  const evidence = new Map<string, AtlasEvidence>();

  const symbols: AtlasSymbol[] = [];
  for (const row of nodeRows) {
    const evidenceIds: string[] = [];
    const provenance = atlasProvenance(row.source_type);
    if (locatedNode(row)) {
      const endLine = Math.max(row.start_line, row.end_line ?? row.start_line);
      const startColumn = Math.max(0, row.start_column ?? 0);
      const endColumn = Math.max(0, row.end_column ?? startColumn);
      const id = createEvidenceId({
        file: row.file_path,
        startLine: row.start_line,
        startColumn,
        endLine,
        endColumn,
        symbolId: row.id,
      });
      evidenceIds.push(id);
      const excerpt = await excerptReader.read(row.file_path, row.start_line, endLine);
      evidence.set(id, {
        id,
        file: row.file_path,
        start_line: row.start_line,
        start_column: startColumn,
        end_line: endLine,
        end_column: endColumn,
        symbol_id: row.id,
        relationship_id: null,
        resolution_issue_id: null,
        kind: evidenceKind(provenance),
        excerpt: excerpt.excerpt,
        excerpt_status: excerpt.status,
        content_hash: row.content_hash,
        file_content_hash: row.content_hash,
        range_content_hash: null,
      });
    }
    symbols.push({
      id: row.id,
      kind: row.kind === "api_route" ? "endpoint" : row.kind,
      name: row.name,
      qualified_name: row.qualified_name,
      file: row.file_path,
      scope: classifyArchitecturalScope(row.file_path),
      language: row.language,
      location: row.start_line === null ? null : {
        start_line: row.start_line,
        start_column: Math.max(0, row.start_column ?? 0),
        end_line: Math.max(row.start_line, row.end_line ?? row.start_line),
        end_column: Math.max(0, row.end_column ?? row.start_column ?? 0),
      },
      domain_ids: [],
      visibility: row.visibility,
      signature: row.signature,
      content_hash: row.content_hash,
      confidence: row.confidence,
      provenance,
      provenance_category: provenanceCategory(row.provenance_category, row.source_type),
      fact_class: factClass(row.source_type),
      evidence_ids: evidenceIds,
      metadata: parseMetadata(row.metadata_json),
    });
  }

  const relationships: AtlasRelationship[] = [];
  for (const row of edgeRows) {
    if (!nodeIds.has(row.source_node_id) || !nodeIds.has(row.target_node_id)) continue;
    const provenance = atlasProvenance(row.source_type);
    const category = provenanceCategory(row.provenance_category, row.source_type);
    const metadata = { ...parseMetadata(row.metadata_json), owner: row.owner_kind };
    const evidenceIds: string[] = [];
    if (row.file_path !== null) {
      const line = Math.max(1, row.line ?? 1);
      const id = createEvidenceId({
        file: row.file_path,
        startLine: line,
        startColumn: 0,
        endLine: line,
        endColumn: 0,
        relationshipId: row.id,
      });
      evidenceIds.push(id);
      const excerpt = await excerptReader.read(row.file_path, line, line);
      evidence.set(id, {
        id,
        file: row.file_path,
        start_line: line,
        start_column: 0,
        end_line: line,
        end_column: 0,
        symbol_id: null,
        relationship_id: row.id,
        resolution_issue_id: null,
        kind: evidenceKind(provenance),
        excerpt: excerpt.excerpt,
        excerpt_status: excerpt.status,
        content_hash: null,
        file_content_hash: fileContentHashes.get(row.file_path) ?? null,
        range_content_hash: null,
      });
    }
    relationships.push({
      id: row.id,
      source: row.source_node_id,
      target: row.target_node_id,
      type: row.edge_type,
      confidence: row.confidence,
      provenance,
      provenance_category: category,
      fact_class: factClass(row.source_type, row.owner_kind),
      target_resolution: targetResolution(metadata, category, row.source_type),
      execution_semantics: executionSemantics(row.edge_type, metadata),
      evidence_ids: evidenceIds,
      metadata,
    });
  }

  const resolutionIssues: AtlasResolutionIssue[] = [];
  for (const row of resolutionIssueRows) {
    if (!nodeIds.has(row.source_node_id)) continue;
    const metadata = parseMetadata(row.metadata_json);
    const excerpt = await excerptReader.read(row.file_path, row.line, row.line);
    const evidenceId = createEvidenceId({
      file: row.file_path,
      startLine: row.line,
      startColumn: Math.max(0, row.column_number),
      endLine: row.line,
      endColumn: Math.max(0, row.column_number),
      symbolId: row.source_node_id,
      resolutionIssueId: row.id,
    });
    evidence.set(evidenceId, {
      id: evidenceId,
      file: row.file_path,
      start_line: row.line,
      start_column: Math.max(0, row.column_number),
      end_line: row.line,
      end_column: Math.max(0, row.column_number),
      symbol_id: row.source_node_id,
      relationship_id: null,
      resolution_issue_id: row.id,
      kind: evidenceKind(typeof metadata.provenance === "string" ? metadata.provenance : "unresolved"),
      excerpt: excerpt.excerpt,
      excerpt_status: excerpt.status,
      content_hash: null,
      file_content_hash: fileContentHashes.get(row.file_path) ?? null,
      range_content_hash: null,
    });
    let candidateIds: string[] = [];
    try {
      const parsed = JSON.parse(row.candidate_node_ids_json) as unknown;
      if (Array.isArray(parsed)) {
        candidateIds = parsed.filter((candidate): candidate is string =>
          typeof candidate === "string" && nodeIds.has(candidate)
        );
      }
    } catch {
      candidateIds = [];
    }
    resolutionIssues.push({
      id: row.id,
      source_id: row.source_node_id,
      reference_kind: row.reference_kind,
      reference_name: row.reference_name,
      reference_hash: row.reference_hash,
      file: row.file_path,
      line: row.line,
      column: Math.max(0, row.column_number),
      reason: row.reason,
      candidate_ids: candidateIds,
      provenance_category: issueProvenance(row.reason),
      confidence: typeof metadata.confidence === "number" ? metadata.confidence : null,
      evidence_ids: [evidenceId],
      metadata,
    });
  }

  const domains = domainProjection(symbols, relationships);
  const entrypointIds = symbols.filter(isArchitecturalEntrypoint).map((symbol) => symbol.id);
  const atlas: Atlas = {
    schema_version: ATLAS_SCHEMA_VERSION,
    generator: { name: "CodeAtlas", version: CODEATLAS_VERSION, indexer_version: INDEXER_VERSION },
    project: {
      id: `repo:${input.repositoryId}`,
      name: input.repositoryName,
      root: ".",
      git_commit: !input.gitAvailable || input.headCommit === "unborn" ? null : input.headCommit,
      git_branch: input.gitAvailable ? input.branch : null,
      dirty,
    },
    snapshot: { id: snapshotId, created_at: createdAt },
    symbols,
    relationships,
    evidence: [...evidence.values()],
    resolution_issues: resolutionIssues,
    domains,
    entrypoint_ids: entrypointIds,
    flows: [],
    control_flows: [],
    impact: { forward: {}, reverse: {}, scores: [] },
    git_changes: [],
    rules: [],
    rule_violations: [],
    review_findings: [],
    statistics: {
      files: symbols.filter((symbol) => symbol.kind === "file").length,
      symbols: symbols.length,
      relationships: relationships.length,
      domains: domains.length,
      entrypoints: entrypointIds.length,
      flows: 0,
      control_flows: 0,
      rule_violations: 0,
      review_findings: 0,
    },
  };
  return normalizeAtlas(atlas);
}
