import type { Atlas, AtlasEvidence } from "./models.js";

export interface EvidenceValidationResult {
  valid: AtlasEvidence[];
  rejected: Array<{ id: string; reason: string }>;
}

function validRange(evidence: AtlasEvidence): boolean {
  if (evidence.start_line < 1 || evidence.end_line < evidence.start_line) return false;
  if (evidence.start_column < 0 || evidence.end_column < 0) return false;
  return evidence.end_line !== evidence.start_line || evidence.end_column >= evidence.start_column;
}

function overlapsLocation(
  evidence: AtlasEvidence,
  location: NonNullable<Atlas["symbols"][number]["location"]>,
): boolean {
  return evidence.end_line >= location.start_line && evidence.start_line <= location.end_line;
}

function snapshotContainsFile(atlas: Atlas, file: string): boolean {
  return atlas.symbols.some((symbol) =>
    symbol.file === file ||
    (symbol.kind === "file" && (symbol.qualified_name === file || symbol.name === file)),
  ) || atlas.git_changes.some((change) => change.file === file && change.status !== "DELETED");
}

export function evidenceRejectionReason(atlas: Atlas, evidence: AtlasEvidence): string | null {
  if (evidence.file.trim().length === 0) return "evidence has no file path";
  if (!validRange(evidence)) return "evidence has an invalid line or column range";
  if (evidence.excerpt === null) return "evidence source could not be resolved in the indexed snapshot";
  if (!snapshotContainsFile(atlas, evidence.file)) return "evidence file is not present in the indexed snapshot";

  if (evidence.symbol_id !== null) {
    const symbol = atlas.symbols.find((item) => item.id === evidence.symbol_id);
    if (symbol === undefined) return "evidence references an unknown symbol";
    if (symbol.file !== null && symbol.file !== evidence.file) return "evidence file does not match its symbol";
    if (symbol.location !== null && !overlapsLocation(evidence, symbol.location)) {
      return "evidence line range does not overlap its symbol";
    }
    if (
      evidence.content_hash !== null &&
      symbol.content_hash !== null &&
      evidence.content_hash !== symbol.content_hash
    ) {
      return "evidence content hash does not match its symbol";
    }
  }

  if (evidence.relationship_id !== null) {
    const relationship = atlas.relationships.find((item) => item.id === evidence.relationship_id);
    if (relationship === undefined) return "evidence references an unknown relationship";
    if (!relationship.evidence_ids.includes(evidence.id)) return "relationship does not reference the evidence record";
  }

  return null;
}

export function validateEvidenceIds(atlas: Atlas, evidenceIds: readonly string[]): EvidenceValidationResult {
  const evidenceById = new Map(atlas.evidence.map((evidence) => [evidence.id, evidence]));
  const valid: AtlasEvidence[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const id of evidenceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const evidence = evidenceById.get(id);
    if (evidence === undefined) {
      rejected.push({ id, reason: "evidence ID does not exist" });
      continue;
    }
    const reason = evidenceRejectionReason(atlas, evidence);
    if (reason === null) valid.push(evidence);
    else rejected.push({ id, reason });
  }
  return { valid, rejected };
}
