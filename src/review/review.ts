import { sha256 } from "../core/hashing.js";
import { createImpactAnalyzer } from "../analysis/impact.js";
import type { Atlas, ReviewFinding } from "../ir/models.js";
import { validateReviewFindings } from "./evidence-validation.js";

export function buildDeterministicReview(atlas: Atlas): ReviewFinding[] {
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const scoreById = new Map(atlas.impact.scores.map((score) => [score.symbol_id, score]));
  const analyzeImpact = createImpactAnalyzer(atlas);
  const reviewedFiles = new Set<string>();
  const findings: ReviewFinding[] = atlas.rule_violations.flatMap((item): ReviewFinding[] => {
    if (item.evidence_ids.length === 0) return [];
    return [{
      id: `finding:${sha256(`rule:${item.id}`)}`,
      severity: item.severity === "error" ? "high" : item.severity === "warning" ? "medium" : "low",
      category: "architecture violation",
      title: `Architecture rule ${item.rule_id} violated`,
      description: item.message,
      changed_symbol_ids: atlas.git_changes.flatMap((change) => change.symbol_ids)
        .filter((id) => item.path.includes(id)),
      impacted_symbol_ids: item.path,
      evidence_ids: item.evidence_ids,
      impact_paths: [],
      confidence: 1,
      provenance: "STATIC_ANALYSIS",
    }];
  });
  for (const change of atlas.git_changes) {
    for (const symbolId of change.symbol_ids) {
      const symbol = symbolById.get(symbolId);
      const score = scoreById.get(symbolId);
      if (symbol === undefined || score === undefined || symbol.evidence_ids.length === 0) continue;
      if (["repository", "package", "directory", "module", "file", "domain", "feature", "configuration", "documentation", "test"].includes(symbol.kind)) continue;
      const paths = analyzeImpact(symbolId, { depth: 8, limit: 25 });
      const impacted = [...new Set(paths.map((item) => item.impacted))];
      if (score.affected_entrypoints > 0 || score.risk === "high") {
        findings.push({
          id: `finding:${sha256(`impact:${change.id}:${symbolId}`)}`,
          severity: score.risk === "high" ? "high" : "medium",
          category: score.affected_entrypoints > 0 ? "public API impact" : "behavioral risk",
          title: `${symbol.name} has ${score.risk} architectural impact`,
          description: score.reasons.join("; "),
          changed_symbol_ids: [symbolId],
          impacted_symbol_ids: impacted,
          evidence_ids: [...new Set([...symbol.evidence_ids, ...paths.flatMap((item) => item.evidence_ids)])],
          impact_paths: paths.slice(0, 10),
          confidence: 1,
          provenance: "STATIC_ANALYSIS",
        });
      }
      const affectedTests = impacted.map((id) => symbolById.get(id)).filter((item) => item?.kind === "test");
      if (
        impacted.length > 0 &&
        affectedTests.length === 0 &&
        (score.risk === "high" || score.affected_entrypoints > 0) &&
        symbol.file !== null &&
        !reviewedFiles.has(symbol.file)
      ) {
        reviewedFiles.add(symbol.file);
        findings.push({
          id: `finding:${sha256(`tests:${change.id}:${symbolId}`)}`,
          severity: "medium",
          category: "missing/affected tests",
          title: `No linked test covers impacted ${symbol.name} paths`,
          description: `CodeAtlas found ${impacted.length} dependents but no TESTS relationship in the affected paths.`,
          changed_symbol_ids: [symbolId],
          impacted_symbol_ids: impacted,
          evidence_ids: symbol.evidence_ids,
          impact_paths: paths.slice(0, 10),
          confidence: 0.8,
          provenance: "STATIC_ANALYSIS",
        });
      }
    }
  }
  return validateReviewFindings(atlas, findings).valid
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 250);
}
