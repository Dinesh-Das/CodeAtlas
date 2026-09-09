import type {
  AtlasEvidence,
  AtlasLocation,
  AtlasProvenanceCategory,
  AtlasTargetResolution,
} from "../ir/models.js";

export const CHANGE_CONTEXT_SCHEMA_VERSION = "1.2" as const;
export type ChangeContextFormat = "json" | "markdown";
export type ChangeIntentKind =
  | "architecture"
  | "bug_fix"
  | "feature"
  | "refactoring"
  | "test_change"
  | "documentation"
  | "unknown";

export interface ChangeContextSymbolRef {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file: string;
  location: AtlasLocation;
  domain_ids: string[];
  visibility: string | null;
  provenance_category: AtlasProvenanceCategory;
  evidence_ids: string[];
}

export interface ChangeContextPath {
  classification: "verified" | "potential";
  symbol_ids: string[];
  relationship_ids: string[];
  evidence_ids: string[];
  confidence: number;
}

export interface ChangeCandidate {
  symbol: ChangeContextSymbolRef;
  retrieval_reasons: string[];
  recommendation: {
    fact_class: "inference";
    action: "inspect" | "modify";
    rationale: string;
    confidence: number;
  };
  supporting_paths: ChangeContextPath[];
  evidence_ids: string[];
}

export interface ChangeContextFlow {
  id: string;
  name: string;
  entrypoint_id: string;
  symbol_ids: string[];
  relationship_ids: string[];
  evidence_ids: string[];
  truncated: boolean;
}

export interface ChangeContextContract {
  symbol: ChangeContextSymbolRef;
  contract_kind: "api" | "type" | "data" | "external" | "event" | "configuration" | "deployment";
  evidence_ids: string[];
}

export interface ChangeContextTest {
  symbol: ChangeContextSymbolRef;
  relationship: "direct" | "impacted" | "task_match";
  evidence_ids: string[];
}

export interface ChangeContextConstraint {
  id: string;
  kind: "architecture_rule" | "architecture_violation" | "decision";
  summary: string;
  evidence_ids: string[];
}

export interface ChangeEditLocation {
  symbol_id: string;
  file: string;
  start_line: number;
  end_line: number;
  action: "inspect" | "modify";
  confidence: number;
  evidence_ids: string[];
}

export interface ChangeContextInvariant {
  id: string;
  statement: string;
  source: "architecture" | "decision" | "contract";
  evidence_ids: string[];
}

export interface ChangeValidationCommand {
  id: string;
  command: string;
  purpose: "test" | "typecheck" | "lint" | "build" | "check";
  source_file: string;
  evidence_ids: string[];
}

export interface ChangeVerificationItem {
  id: string;
  status: "pending" | "passed" | "failed" | "skipped";
  kind: "edit_location" | "contract" | "invariant" | "test" | "command" | "gap";
  instruction: string;
  target_ids: string[];
  command_id: string | null;
  evidence_ids: string[];
}

export interface ChangeContextGap {
  code:
    | "ambiguous_target"
    | "insufficient_task_specificity"
    | "unresolved_reference"
    | "dynamic_relationship"
    | "unsupported_coverage"
    | "budget_truncated";
  message: string;
  target: string | null;
  candidate_ids: string[];
  evidence_ids: string[];
}

export interface ChangeContextEvidence extends Pick<
  AtlasEvidence,
  "id" | "file" | "start_line" | "start_column" | "end_line" | "end_column" |
  "kind" | "excerpt" | "excerpt_status"
> {
  trust: "untrusted_repository_content";
}

export interface ChangeContext {
  schema_version: typeof CHANGE_CONTEXT_SCHEMA_VERSION;
  snapshot: {
    id: string;
    fingerprint: string;
    generations: {
      structural: number;
      semantic: number;
      search: number;
      architecture: number;
    };
  };
  task: string;
  intent: {
    kind: ChangeIntentKind;
    terms: string[];
    explicit_symbols: string[];
    explicit_files: string[];
    explicit_endpoints: string[];
    explicit_domains: string[];
  };
  summary: string;
  change_candidates: ChangeCandidate[];
  edit_locations: ChangeEditLocation[];
  verified_paths: ChangeContextPath[];
  potential_paths: ChangeContextPath[];
  relevant_flows: ChangeContextFlow[];
  affected_contracts: ChangeContextContract[];
  relevant_tests: ChangeContextTest[];
  constraints: ChangeContextConstraint[];
  invariants: ChangeContextInvariant[];
  validation_commands: ChangeValidationCommand[];
  verification_checklist: ChangeVerificationItem[];
  evidence: ChangeContextEvidence[];
  gaps: ChangeContextGap[];
  budget: {
    requested: number;
    used: number;
    unit: "utf8_bytes_upper_bound";
    estimator: "utf8-bytes-upper-bound/v1";
    envelope_reserved: number;
    format: ChangeContextFormat;
  };
  coverage: {
    indexed_files: number;
    indexed_symbols: number;
    languages: string[];
    resolution_issues: number;
    limitations: string[];
  };
  continuation: string | null;
  content_trust: "untrusted_repository_content";
}

export interface ContextPlannerSnapshot {
  id: string;
  fingerprint: string;
  generations: ChangeContext["snapshot"]["generations"];
}

export interface RankedContextSymbol {
  symbolId: string;
  score: number;
  reasons: string[];
  targetResolution: AtlasTargetResolution | null;
}

function evidenceLabel(evidence: ChangeContextEvidence): string {
  return `${evidence.file}:${evidence.start_line}-${evidence.end_line}`;
}

export function renderChangeContextMarkdown(packet: ChangeContext): string {
  const lines = [
    "# CodeAtlas change context",
    "",
    `Task: ${packet.task}`,
    `Intent: ${packet.intent.kind}`,
    `Snapshot: ${packet.snapshot.id}`,
    `Budget: ${packet.budget.used}/${packet.budget.requested} ${packet.budget.unit} (${packet.budget.estimator})`,
    "",
    packet.summary,
    "",
    "## Change candidates",
    ...packet.change_candidates.flatMap((candidate) => [
      `- ${candidate.symbol.qualified_name ?? candidate.symbol.name} (${candidate.symbol.file}:${candidate.symbol.location.start_line})`,
      `  Recommendation (${candidate.recommendation.fact_class}): ${candidate.recommendation.action} — ${candidate.recommendation.rationale}`,
      `  Evidence: ${candidate.evidence_ids.join(", ")}`,
    ]),
    ...packet.edit_locations.map((item) =>
      `- ${item.action}: ${item.file}:${item.start_line}-${item.end_line} (${Math.round(item.confidence * 100)}%)`
    ),
    "",
    "## Verified paths",
    ...packet.verified_paths.map((item) =>
      `- ${item.symbol_ids.join(" -> ")} [${item.evidence_ids.join(", ")}]`
    ),
    "",
    "## Potential paths",
    ...packet.potential_paths.map((item) =>
      `- ${item.symbol_ids.join(" -> ")} (${Math.round(item.confidence * 100)}%) [${item.evidence_ids.join(", ")}]`
    ),
    "",
    "## Tests and contracts",
    ...packet.relevant_tests.map((item) =>
      `- Test: ${item.symbol.qualified_name ?? item.symbol.name} (${item.symbol.file}) [${item.evidence_ids.join(", ")}]`
    ),
    ...packet.affected_contracts.map((item) =>
      `- ${item.contract_kind}: ${item.symbol.qualified_name ?? item.symbol.name} (${item.symbol.file}) [${item.evidence_ids.join(", ")}]`
    ),
    ...packet.invariants.map((item) => `- Invariant: ${item.statement} [${item.evidence_ids.join(", ")}]`),
    "",
    "## Validation",
    ...packet.validation_commands.map((item) => `- ${item.purpose}: \`${item.command}\` (${item.source_file})`),
    ...packet.verification_checklist.map((item) => `- [ ] ${item.instruction}`),
    "",
    "## Constraints and gaps",
    ...packet.constraints.map((item) => `- ${item.kind}: ${item.summary} [${item.evidence_ids.join(", ")}]`),
    ...packet.gaps.map((item) => `- ${item.code}: ${item.message}`),
    "",
    "## Evidence",
    ...packet.evidence.flatMap((item) => [
      `### ${item.id} — ${evidenceLabel(item)}`,
      "```",
      item.excerpt ?? `[${item.excerpt_status}]`,
      "```",
    ]),
    "",
    `Coverage: ${packet.coverage.indexed_files} files, ${packet.coverage.indexed_symbols} symbols; ${packet.coverage.limitations.join("; ") || "no reported limitation"}.`,
    ...(packet.continuation === null ? [] : ["", `Continue: ${packet.continuation}`]),
  ];
  return lines.join("\n");
}

export function serializeChangeContext(
  packet: ChangeContext,
  format: ChangeContextFormat,
): string {
  return format === "json" ? JSON.stringify(packet) : renderChangeContextMarkdown(packet);
}

export function validateChangeContextGrounding(packet: ChangeContext): string[] {
  const selected = new Set(packet.evidence.map((item) => item.id));
  const errors: string[] = [];
  const factualCollections: Array<[string, readonly { evidence_ids: string[] }[]]> = [
    ["change_candidates", packet.change_candidates],
    ["edit_locations", packet.edit_locations],
    ["verified_paths", packet.verified_paths],
    ["potential_paths", packet.potential_paths],
    ["relevant_flows", packet.relevant_flows],
    ["affected_contracts", packet.affected_contracts],
    ["relevant_tests", packet.relevant_tests],
    ["constraints", packet.constraints],
    ["invariants", packet.invariants],
    ["validation_commands", packet.validation_commands],
    ["verification_checklist", packet.verification_checklist],
  ];
  for (const [name, items] of factualCollections) {
    for (const [index, item] of items.entries()) {
      if (item.evidence_ids.length === 0) errors.push(`${name}.${index} has no evidence.`);
    }
  }
  const visit = (value: unknown, location: string): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${location}.${index}`));
      return;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.evidence_ids)) {
      for (const id of record.evidence_ids) {
        if (typeof id === "string" && !selected.has(id)) {
          errors.push(`${location} references omitted evidence ${id}.`);
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "evidence" && key !== "evidence_ids") visit(child, `${location}.${key}`);
    }
  };
  visit(packet, "packet");
  return errors;
}
