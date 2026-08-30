import type { Atlas, ReviewFinding } from "../ir/models.js";

export interface FindingValidationResult {
  valid: ReviewFinding[];
  rejected: Array<{ finding: ReviewFinding; reason: string }>;
}

export function validateReviewFindings(
  atlas: Atlas,
  findings: readonly ReviewFinding[],
): FindingValidationResult {
  const evidenceIds = new Set(atlas.evidence.map((evidence) => evidence.id));
  const symbolIds = new Set(atlas.symbols.map((symbol) => symbol.id));
  const valid: ReviewFinding[] = [];
  const rejected: Array<{ finding: ReviewFinding; reason: string }> = [];
  for (const finding of findings) {
    const reason = finding.evidence_ids.length === 0
      ? "finding has no source evidence"
      : finding.evidence_ids.some((id) => !evidenceIds.has(id))
        ? "finding references unknown evidence"
        : [...finding.changed_symbol_ids, ...finding.impacted_symbol_ids].some((id) => !symbolIds.has(id))
          ? "finding references an unknown symbol"
          : null;
    if (reason === null) valid.push(finding);
    else rejected.push({ finding, reason });
  }
  return { valid, rejected };
}
