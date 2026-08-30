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
  }
  for (const entrypointId of atlas.entrypoint_ids) {
    if (!symbolIds.has(entrypointId)) errors.push(`Missing entrypoint symbol ${entrypointId}`);
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
