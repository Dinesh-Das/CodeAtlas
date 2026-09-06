import type { Atlas } from "./models.js";
import { atlasSchema } from "./schema.js";

export interface AtlasValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAtlas(atlas: Atlas): AtlasValidationResult {
  const errors: string[] = [];
  const schemaResult = atlasSchema.safeParse(atlas);
  if (!schemaResult.success) {
    errors.push(...schemaResult.error.issues.map((issue) =>
      `${issue.path.join(".") || "atlas"}: ${issue.message}`,
    ));
  }

  const unique = (label: string, ids: readonly string[]): Set<string> => {
    const result = new Set<string>();
    for (const id of ids) {
      if (result.has(id)) errors.push(`Duplicate ${label} ID: ${id}`);
      result.add(id);
    }
    return result;
  };
  const symbolIds = unique("symbol", atlas.symbols.map((symbol) => symbol.id));
  const relationshipIds = unique("relationship", atlas.relationships.map((edge) => edge.id));
  const evidenceIds = unique("evidence", atlas.evidence.map((evidence) => evidence.id));
  const resolutionIssues = atlas.resolution_issues ?? [];
  const resolutionIssueIds = unique("resolution issue", resolutionIssues.map((issue) => issue.id));
  const domainIds = unique("domain", atlas.domains.map((domain) => domain.id));

  for (const relationship of atlas.relationships) {
    if (!symbolIds.has(relationship.source)) {
      errors.push(`Relationship ${relationship.id} has missing source ${relationship.source}`);
    }
    if (!symbolIds.has(relationship.target)) {
      errors.push(`Relationship ${relationship.id} has missing target ${relationship.target}`);
    }
    for (const id of relationship.evidence_ids) {
      if (!evidenceIds.has(id)) errors.push(`Relationship ${relationship.id} has missing evidence ${id}`);
    }
  }
  for (const symbol of atlas.symbols) {
    for (const id of symbol.domain_ids) {
      if (!domainIds.has(id)) errors.push(`Symbol ${symbol.id} has missing domain ${id}`);
    }
    for (const id of symbol.evidence_ids) {
      if (!evidenceIds.has(id)) errors.push(`Symbol ${symbol.id} has missing evidence ${id}`);
    }
  }
  for (const evidence of atlas.evidence) {
    if (evidence.symbol_id !== null && !symbolIds.has(evidence.symbol_id)) {
      errors.push(`Evidence ${evidence.id} has missing symbol ${evidence.symbol_id}`);
    }
    if (evidence.relationship_id !== null && !relationshipIds.has(evidence.relationship_id)) {
      errors.push(`Evidence ${evidence.id} has missing relationship ${evidence.relationship_id}`);
    }
    if (evidence.resolution_issue_id !== null && !resolutionIssueIds.has(evidence.resolution_issue_id)) {
      errors.push(`Evidence ${evidence.id} has missing resolution issue ${evidence.resolution_issue_id}`);
    }
  }
  for (const issue of resolutionIssues) {
    if (!symbolIds.has(issue.source_id)) {
      errors.push(`Resolution issue ${issue.id} has missing source ${issue.source_id}`);
    }
    for (const id of issue.candidate_ids) {
      if (!symbolIds.has(id)) errors.push(`Resolution issue ${issue.id} has missing candidate ${id}`);
    }
    for (const id of issue.evidence_ids) {
      if (!evidenceIds.has(id)) errors.push(`Resolution issue ${issue.id} has missing evidence ${id}`);
    }
  }
  for (const entrypointId of atlas.entrypoint_ids) {
    if (!symbolIds.has(entrypointId)) errors.push(`Missing entrypoint symbol ${entrypointId}`);
  }
  unique("control-flow", atlas.control_flows.map((flow) => flow.id));
  for (const flow of atlas.control_flows) {
    if (!symbolIds.has(flow.symbol_id)) {
      errors.push(`Control flow ${flow.id} has missing symbol ${flow.symbol_id}`);
    }
    const nodeIds = unique(`control-flow node in ${flow.id}`, flow.nodes.map((node) => node.id));
    unique(`control-flow edge in ${flow.id}`, flow.edges.map((edge) => edge.id));
    for (const node of flow.nodes) {
      for (const id of node.evidence_ids) {
        if (!evidenceIds.has(id)) errors.push(`Control-flow node ${node.id} has missing evidence ${id}`);
      }
    }
    for (const edge of flow.edges) {
      if (!nodeIds.has(edge.source)) errors.push(`Control-flow edge ${edge.id} has missing source ${edge.source}`);
      if (!nodeIds.has(edge.target)) errors.push(`Control-flow edge ${edge.id} has missing target ${edge.target}`);
    }
  }
  for (const finding of atlas.review_findings) {
    if (finding.evidence_ids.length === 0) errors.push(`Review finding ${finding.id} has no evidence`);
    for (const id of finding.evidence_ids) {
      if (!evidenceIds.has(id)) errors.push(`Review finding ${finding.id} has missing evidence ${id}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidAtlas(atlas: Atlas): void {
  const result = validateAtlas(atlas);
  if (!result.valid) {
    throw new Error(`Invalid CodeAtlas IR:\n${result.errors.map((error) => `- ${error}`).join("\n")}`);
  }
}
