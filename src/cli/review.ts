import { buildAtlasAtGitHead } from "../git/ref-atlas.js";
import type { Atlas } from "../ir/models.js";

export interface ReviewArchitectureSummary {
  changed_file_count: number;
  changed_symbol_ids: string[];
  impacted_symbol_ids: string[];
  affected_entrypoint_ids: string[];
  affected_domain_ids: string[];
  affected_test_ids: string[];
  rule_violation_count: number;
  findings_by_severity: Record<"critical" | "high" | "medium" | "low", number>;
}

function isTestSymbol(symbol: Atlas["symbols"][number]): boolean {
  return symbol.kind === "test" || /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[^/]+$/iu.test(symbol.file ?? "");
}

export function summarizeReviewArchitecture(atlas: Atlas): ReviewArchitectureSummary {
  const changedSymbolIds = new Set(atlas.git_changes.flatMap((change) => change.symbol_ids));
  const impactedSymbolIds = new Set(atlas.git_changes.flatMap((change) => change.impacted_symbol_ids));
  for (const finding of atlas.review_findings) {
    for (const id of finding.impacted_symbol_ids) impactedSymbolIds.add(id);
  }
  for (const id of changedSymbolIds) impactedSymbolIds.delete(id);

  const affectedIds = new Set([...changedSymbolIds, ...impactedSymbolIds]);
  const affectedSymbols = atlas.symbols.filter((symbol) => affectedIds.has(symbol.id));
  const affectedDomainIds = new Set(affectedSymbols.flatMap((symbol) => symbol.domain_ids));
  const affectedTestIds = new Set(
    affectedSymbols.filter(isTestSymbol).map((symbol) => symbol.id),
  );
  for (const change of atlas.git_changes) {
    for (const id of change.related_test_ids) affectedTestIds.add(id);
  }
  const findingsBySeverity: ReviewArchitectureSummary["findings_by_severity"] = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of atlas.review_findings) findingsBySeverity[finding.severity] += 1;

  return {
    changed_file_count: atlas.git_changes.length,
    changed_symbol_ids: [...changedSymbolIds].sort((left, right) => left.localeCompare(right)),
    impacted_symbol_ids: [...impactedSymbolIds].sort((left, right) => left.localeCompare(right)),
    affected_entrypoint_ids: atlas.entrypoint_ids.filter((id) => affectedIds.has(id)).sort((left, right) => left.localeCompare(right)),
    affected_domain_ids: [...affectedDomainIds].sort((left, right) => left.localeCompare(right)),
    affected_test_ids: [...affectedTestIds].sort((left, right) => left.localeCompare(right)),
    rule_violation_count: atlas.rule_violations.length,
    findings_by_severity: findingsBySeverity,
  };
}

export async function reviewRepository(
  startPath = process.cwd(),
  base = "HEAD",
  head = "HEAD",
) {
  const atlas = await buildAtlasAtGitHead(startPath, base, head, { snapshot: false });
  return {
    base,
    head,
    architecture: summarizeReviewArchitecture(atlas),
    changes: atlas.git_changes,
    violations: atlas.rule_violations,
    findings: atlas.review_findings,
  };
}

export function formatReviewResult(result: Awaited<ReturnType<typeof reviewRepository>>): string {
  const summary = result.architecture;
  return [
    `Review ${result.base}..${result.head}`,
    "",
    "Changed:",
    `  ${summary.changed_symbol_ids.length} symbols`,
    `  ${summary.changed_file_count} files`,
    "",
    "Impact:",
    `  ${summary.impacted_symbol_ids.length} transitive dependents`,
    `  ${summary.affected_entrypoint_ids.length} entrypoints`,
    `  ${summary.affected_domain_ids.length} domains`,
    `  ${summary.affected_test_ids.length} tests`,
    "",
    "Architecture:",
    `  ${summary.rule_violation_count} rule violations`,
    "",
    "Review:",
    `  ${summary.findings_by_severity.critical} critical`,
    `  ${summary.findings_by_severity.high} high`,
    `  ${summary.findings_by_severity.medium} medium`,
    `  ${summary.findings_by_severity.low} low`,
    ...(result.findings.length > 0 ? [""] : []),
    ...result.findings.map((finding) =>
      `[${finding.severity.toUpperCase()}] ${finding.title}\n  ${finding.description}`,
    ),
  ].join("\n");
}
