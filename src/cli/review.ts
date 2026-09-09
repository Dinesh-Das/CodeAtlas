import { buildAtlasAtGitHead } from "../git/ref-atlas.js";
import type { Atlas } from "../ir/models.js";

const CONTRACT_KINDS = new Set([
  "endpoint", "http_contract", "contract_schema", "contract_drift", "database_model",
  "database_table", "external_service", "environment_variable", "configuration_key",
  "event", "queue", "topic",
]);

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

export interface SourceFreeReviewReport {
  schema_version: "1.0";
  source_policy: "locations_and_graph_facts_only";
  base: string;
  head: string;
  architecture: ReviewArchitectureSummary;
  files: Array<{
    status: string;
    file: string;
    previous_file: string | null;
    line_ranges: Array<{ start_line: number; end_line: number }>;
    changed_symbol_ids: string[];
    impacted_symbol_ids: string[];
    related_test_ids: string[];
  }>;
  contract_changes: Array<{
    status: string;
    symbol_id: string | null;
    kind: string;
    file: string;
  }>;
  findings: Array<{
    id: string;
    severity: string;
    category: string;
    title: string;
    confidence: number;
    evidence_ids: string[];
  }>;
  violations: Array<{
    id: string;
    rule_id: string;
    severity: string;
    source_id: string;
    target_id: string | null;
    evidence_ids: string[];
  }>;
  evidence_locations: Array<{
    id: string;
    file: string;
    start_line: number;
    end_line: number;
    kind: string;
  }>;
  verification: Array<{
    id: string;
    status: "pending";
    instruction: string;
    target_ids: string[];
  }>;
}

export function sourceFreeReviewReport(
  atlas: Atlas,
  base: string,
  head: string,
): SourceFreeReviewReport {
  const architecture = summarizeReviewArchitecture(atlas);
  const evidenceIds = new Set([
    ...atlas.git_changes.flatMap((change) => change.evidence_ids),
    ...atlas.review_findings.flatMap((finding) => finding.evidence_ids),
    ...atlas.rule_violations.flatMap((violation) => violation.evidence_ids),
  ]);
  return {
    schema_version: "1.0",
    source_policy: "locations_and_graph_facts_only",
    base,
    head,
    architecture,
    files: atlas.git_changes.map((change) => ({
      status: change.status,
      file: change.file,
      previous_file: change.previous_file,
      line_ranges: change.line_ranges,
      changed_symbol_ids: change.symbol_ids,
      impacted_symbol_ids: change.impacted_symbol_ids,
      related_test_ids: change.related_test_ids,
    })),
    contract_changes: atlas.git_changes.flatMap((change) =>
      change.symbol_changes.filter((symbol) => CONTRACT_KINDS.has(symbol.kind)).map((symbol) => ({
        status: symbol.status,
        symbol_id: symbol.symbol_id,
        kind: symbol.kind,
        file: symbol.file,
      }))
    ),
    findings: atlas.review_findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      confidence: finding.confidence,
      evidence_ids: finding.evidence_ids,
    })),
    violations: atlas.rule_violations.map((violation) => ({
      id: violation.id,
      rule_id: violation.rule_id,
      severity: violation.severity,
      source_id: violation.source_id,
      target_id: violation.target_id,
      evidence_ids: violation.evidence_ids,
    })),
    evidence_locations: atlas.evidence.filter((evidence) => evidenceIds.has(evidence.id)).map((evidence) => ({
      id: evidence.id,
      file: evidence.file,
      start_line: evidence.start_line,
      end_line: evidence.end_line,
      kind: evidence.kind,
    })),
    verification: [
      ...architecture.affected_test_ids.map((id) => ({
        id: `test:${id}`,
        status: "pending" as const,
        instruction: "Run the affected test and record its result.",
        target_ids: [id],
      })),
      ...atlas.review_findings.map((finding) => ({
        id: `finding:${finding.id}`,
        status: "pending" as const,
        instruction: `Resolve or explicitly accept the ${finding.severity} ${finding.category} finding.`,
        target_ids: finding.changed_symbol_ids,
      })),
    ],
  };
}

export async function createSourceFreeReviewReport(
  startPath = process.cwd(),
  base = "HEAD",
  head = "HEAD",
): Promise<SourceFreeReviewReport> {
  const atlas = await buildAtlasAtGitHead(startPath, base, head, { snapshot: false });
  return sourceFreeReviewReport(atlas, base, head);
}

export function formatSourceFreeReviewReport(report: SourceFreeReviewReport): string {
  return [
    "<!-- codeatlas-review -->",
    "## CodeAtlas architecture review",
    "",
    `Graph-only report for \`${report.base}..${report.head}\`; source excerpts and diffs are excluded.`,
    "",
    `- Changed files: ${report.architecture.changed_file_count}`,
    `- Changed symbols: ${report.architecture.changed_symbol_ids.length}`,
    `- Transitive dependents: ${report.architecture.impacted_symbol_ids.length}`,
    `- Affected tests: ${report.architecture.affected_test_ids.length}`,
    `- Contract changes: ${report.contract_changes.length}`,
    `- Rule violations: ${report.architecture.rule_violation_count}`,
    `- Review findings: ${report.findings.length}`,
    "",
    "### Verification",
    ...(report.verification.length === 0
      ? ["- [x] No affected tests or review findings were identified."]
      : report.verification.slice(0, 20).map((item) => `- [ ] ${item.instruction} (${item.target_ids.join(", ")})`)),
  ].join("\n");
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
