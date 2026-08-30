import type { Atlas, ReviewFinding } from "../ir/models.js";
import { validateEvidenceIds } from "../ir/evidence-validation.js";

export interface FindingValidationResult {
  valid: ReviewFinding[];
  rejected: Array<{ finding: ReviewFinding; reason: string }>;
}

export function validateReviewFindings(
  atlas: Atlas,
  findings: readonly ReviewFinding[],
): FindingValidationResult {
  const symbolIds = new Set(atlas.symbols.map((symbol) => symbol.id));
  const valid: ReviewFinding[] = [];
  const rejected: Array<{ finding: ReviewFinding; reason: string }> = [];
  for (const finding of findings) {
    const evidenceValidation = validateEvidenceIds(atlas, finding.evidence_ids);
    const reason = finding.evidence_ids.length === 0
      ? "finding has no source evidence"
      : evidenceValidation.rejected.length > 0
        ? `finding references invalid evidence: ${evidenceValidation.rejected[0]!.reason}`
        : [...finding.changed_symbol_ids, ...finding.impacted_symbol_ids].some((id) => !symbolIds.has(id))
          ? "finding references an unknown symbol"
          : null;
    if (reason === null) valid.push(finding);
    else rejected.push({ finding, reason });
  }
  return { valid, rejected };
}
