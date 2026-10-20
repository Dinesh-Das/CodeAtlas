import { describeImpact } from "../analysis/impact.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { isPrimaryArchitectureSymbol, symbolArchitecturalScope } from "../analysis/scope.js";
import { CodeAtlasError } from "../core/errors.js";
import { workspacePaths } from "../core/workspace.js";
import { buildAtlasAtGitHead } from "../git/ref-atlas.js";
import type {
  Atlas,
  AtlasEvidence,
  AtlasFlow,
  AtlasSymbol,
  ImpactPath,
} from "../ir/models.js";
import { architectureService } from "../service/architecture-service.js";
import { loadV2Config } from "../rules/config.js";
import type { CodeAtlasV2Config } from "../rules/types.js";
import { createAtlasProjection, type AtlasProjection } from "../service/atlas-projection.js";
import { openDatabase } from "../storage/database.js";
import type { QueryStore } from "../storage/query-store.js";
import { searchNodes, type SearchResult } from "../storage/search.js";
import { fitChangeContextToBudget } from "./budgeter.js";
import { classifyChangeTask, ftsTaskQuery } from "./intent.js";
import {
  CHANGE_CONTEXT_SCHEMA_VERSION,
  type ChangeCandidate,
  type ChangeContext,
  type ChangeContextConstraint,
  type ChangeContextContract,
  type ChangeContextFlow,
  type ChangeContextFormat,
  type ChangeContextGap,
  type ChangeContextInvariant,
  type ChangeContextPath,
  type ChangeContextSymbolRef,
  type ChangeContextTest,
  type ChangeValidationCommand,
  type ChangeVerificationItem,
  type ContextPlannerSnapshot,
  validateChangeContextGrounding,
} from "./packet.js";
import { rankChangeCandidates } from "./ranker.js";

export interface CompileChangeContextOptions {
  budget?: number;
  format?: ChangeContextFormat;
  envelopeReserve?: number;
  gitBase?: string;
}

export interface ChangeContextResources {
  projection?: AtlasProjection;
  queryStore?: QueryStore;
  v2Config?: CodeAtlasV2Config;
}

const GENERIC_TASK_TERMS = new Set([
  "bug", "code", "feature", "fix", "implement", "improve", "issue", "problem", "refactor",
  "something", "thing", "work",
]);
const CONTRACT_KINDS = new Map<string, ChangeContextContract["contract_kind"]>([
  ["endpoint", "api"],
  ["interface", "type"],
  ["type", "type"],
  ["database_model", "data"],
  ["database_table", "data"],
  ["external_service", "external"],
  ["external_actor", "external"],
  ["http_contract", "api"],
  ["contract_schema", "type"],
  ["contract_drift", "api"],
  ["event", "event"],
  ["queue", "event"],
  ["topic", "event"],
  ["environment_variable", "configuration"],
  ["configuration_key", "configuration"],
  ["service", "deployment"],
  ["process", "deployment"],
  ["job", "deployment"],
  ["datastore", "deployment"],
]);

const VALIDATION_SCRIPTS = ["test", "typecheck", "lint", "build", "check"] as const;

function validationCommands(atlas: Atlas, repositoryRoot: string): ChangeValidationCommand[] {
  const manifest = "package.json";
  const manifestPath = path.join(repositoryRoot, manifest);
  if (!existsSync(manifestPath)) return [];
  let scripts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { scripts?: unknown };
    scripts = typeof parsed.scripts === "object" && parsed.scripts !== null
      ? parsed.scripts as Record<string, unknown>
      : {};
  } catch {
    return [];
  }
  const evidenceIds = atlas.evidence
    .filter((item) => item.file === manifest)
    .map((item) => item.id)
    .slice(0, 1);
  if (evidenceIds.length === 0) return [];
  const runner = existsSync(path.join(repositoryRoot, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(path.join(repositoryRoot, "yarn.lock")) ? "yarn" : "npm";
  return VALIDATION_SCRIPTS.flatMap((script): ChangeValidationCommand[] => {
    if (typeof scripts[script] !== "string") return [];
    return [{
      id: `package-script:${script}`,
      command: `${runner} run ${script}`,
      purpose: script,
      source_file: manifest,
      evidence_ids: evidenceIds,
    }];
  });
}

function verificationChecklist(input: {
  edits: ChangeContext["edit_locations"];
  contracts: ChangeContextContract[];
  invariants: ChangeContextInvariant[];
  tests: ChangeContextTest[];
  commands: ChangeValidationCommand[];
  gaps: ChangeContextGap[];
}): ChangeVerificationItem[] {
  return [
    ...input.edits.slice(0, 6).map((item): ChangeVerificationItem => ({
      id: `edit:${item.symbol_id}`,
      status: "pending",
      kind: "edit_location",
      instruction: `Inspect the source-backed edit location ${item.file}:${item.start_line}.`,
      target_ids: [item.symbol_id],
      command_id: null,
      evidence_ids: item.evidence_ids,
    })),
    ...input.contracts.slice(0, 6).map((item): ChangeVerificationItem => ({
      id: `contract:${item.symbol.id}`,
      status: "pending",
      kind: "contract",
      instruction: `Confirm the ${item.contract_kind} contract ${item.symbol.qualified_name ?? item.symbol.name} remains compatible.`,
      target_ids: [item.symbol.id],
      command_id: null,
      evidence_ids: item.evidence_ids,
    })),
    ...input.invariants.slice(0, 4).map((item): ChangeVerificationItem => ({
      id: `invariant:${item.id}`,
      status: "pending",
      kind: "invariant",
      instruction: item.statement,
      target_ids: [item.id],
      command_id: null,
      evidence_ids: item.evidence_ids,
    })),
    ...input.tests.slice(0, 6).map((item): ChangeVerificationItem => ({
      id: `test:${item.symbol.id}`,
      status: "pending",
      kind: "test",
      instruction: `Run or inspect ${item.symbol.file}.`,
      target_ids: [item.symbol.id],
      command_id: null,
      evidence_ids: item.evidence_ids,
    })),
    ...(input.commands.length === 0 ? [] : [{
      id: "command:validation",
      status: "pending" as const,
      kind: "command" as const,
      instruction: "Run every validation_commands entry and record each result.",
      target_ids: input.commands.map((item) => item.id),
      command_id: null,
      evidence_ids: [...new Set(input.commands.flatMap((item) => item.evidence_ids))],
    }]),
    ...input.gaps.filter((item) => item.evidence_ids.length > 0).slice(0, 4)
      .map((item, index): ChangeVerificationItem => ({
        id: `gap:${item.code}:${index}`,
        status: "pending",
        kind: "gap",
        instruction: `Resolve before editing: ${item.message}`,
        target_ids: item.candidate_ids,
        command_id: null,
        evidence_ids: item.evidence_ids,
      })),
  ];
}

function symbolRef(symbol: AtlasSymbol): ChangeContextSymbolRef | null {
  if (symbol.file === null || symbol.location === null || symbol.evidence_ids.length === 0) return null;
  return {
    id: symbol.id,
    kind: symbol.kind,
    name: symbol.name,
    qualified_name: symbol.qualified_name,
    file: symbol.file,
    location: symbol.location,
    domain_ids: symbol.domain_ids,
    visibility: symbol.visibility,
    provenance_category: symbol.provenance_category,
    evidence_ids: symbol.evidence_ids,
  };
}

function contextPath(path: ImpactPath): ChangeContextPath {
  return {
    classification: path.classification === "potential" ? "potential" : "verified",
    symbol_ids: path.path,
    relationship_ids: path.relationship_ids,
    evidence_ids: path.evidence_ids,
    confidence: path.confidence ?? (path.classification === "potential" ? 0.5 : 1),
  };
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function ftsCandidates(repositoryRoot: string, query: string | null): SearchResult[] {
  if (query === null) return [];
  const database = openDatabase(workspacePaths(repositoryRoot).database, { readonly: true });
  try {
    return searchNodes(database, query, 100);
  } catch {
    return [];
  } finally {
    database.close();
  }
}

function ambiguousGaps(atlas: Atlas, references: readonly string[]): ChangeContextGap[] {
  return references.flatMap((reference): ChangeContextGap[] => {
    const normalized = reference.toLocaleLowerCase();
    const matches = atlas.symbols.filter((symbol) =>
      symbol.name.toLocaleLowerCase() === normalized ||
      symbol.qualified_name?.toLocaleLowerCase() === normalized
    );
    return matches.length <= 1 ? [] : [{
      code: "ambiguous_target",
      message: `${reference} resolves to ${matches.length} symbols; use an exact stable ID before editing.`,
      target: reference,
      candidate_ids: matches.map((symbol) => symbol.id).sort(),
      evidence_ids: [...new Set(matches.flatMap((symbol) => symbol.evidence_ids))],
    }];
  });
}

function pathKey(path: ChangeContextPath): string {
  return `${path.classification}:${path.symbol_ids.join("\0")}:${path.relationship_ids.join("\0")}`;
}

function uniquePaths(paths: readonly ChangeContextPath[]): ChangeContextPath[] {
  const seen = new Set<string>();
  return paths.filter((item) => {
    const key = pathKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flowSlice(flow: AtlasFlow): ChangeContextFlow {
  const paths = flow.paths ?? [];
  return {
    id: flow.id,
    name: flow.name,
    entrypoint_id: flow.entrypoint_id,
    symbol_ids: [...new Set([
      flow.entrypoint_id,
      ...flow.steps.map((step) => step.symbol_id),
      ...paths.flatMap((path) => path.symbol_ids),
    ])],
    relationship_ids: [...new Set([
      ...flow.steps.flatMap((step) => step.relationship_id === null ? [] : [step.relationship_id]),
      ...paths.flatMap((path) => path.relationship_ids),
    ])],
    evidence_ids: [...new Set([
      ...flow.steps.flatMap((step) => step.evidence_ids),
      ...(flow.edges ?? []).flatMap((edge) => edge.evidence_ids),
    ])],
    truncated: flow.truncated || paths.some((path) => path.truncated),
  };
}

function relevantConstraints(
  atlas: Atlas,
  relevantIds: ReadonlySet<string>,
): ChangeContextConstraint[] {
  const violations = atlas.rule_violations.flatMap((violation): ChangeContextConstraint[] => {
    const relevant = relevantIds.has(violation.source_id) ||
      (violation.target_id !== null && relevantIds.has(violation.target_id)) ||
      violation.path.some((id) => relevantIds.has(id));
    return !relevant || violation.evidence_ids.length === 0 ? [] : [{
      id: violation.id,
      kind: "architecture_violation",
      summary: violation.message,
      evidence_ids: violation.evidence_ids,
    }];
  });
  const decisions = atlas.symbols.flatMap((symbol): ChangeContextConstraint[] => {
    if (symbol.kind !== "documentation" || symbol.evidence_ids.length === 0) return [];
    const documentKind = typeof symbol.metadata.document_kind === "string"
      ? symbol.metadata.document_kind
      : "";
    if (documentKind !== "decision" && documentKind !== "adr") return [];
    const linkedToTask = relevantIds.has(symbol.id) || atlas.relationships.some((relationship) =>
      (relationship.source === symbol.id && relevantIds.has(relationship.target)) ||
      (relationship.target === symbol.id && relevantIds.has(relationship.source))
    );
    if (!linkedToTask) return [];
    return [{
      id: symbol.id,
      kind: "decision",
      summary: `Architecture decision: ${symbol.name}`,
      evidence_ids: symbol.evidence_ids,
    }];
  });
  return uniqueById([...violations, ...decisions]).slice(0, 20);
}

function configEvidenceIds(atlas: Atlas): string[] {
  return atlas.evidence.filter((item) => item.file === ".codeatlas.yml")
    .map((item) => item.id)
    .slice(0, 2);
}

function selectorMatchesSymbol(atlas: Atlas, symbol: AtlasSymbol, selector: Record<string, string>): boolean {
  return Object.entries(selector).every(([key, expected]) => {
    const value = expected.toLocaleLowerCase();
    if (key === "kind") return symbol.kind.toLocaleLowerCase() === value;
    if (key === "matches_path") return (symbol.file ?? "").toLocaleLowerCase().includes(value);
    if (key === "domain") return symbol.domain_ids.some((id) =>
      atlas.domains.find((domain) => domain.id === id)?.name.toLocaleLowerCase() === value
    );
    return String(symbol.metadata[key] ?? "").toLocaleLowerCase() === value;
  });
}

function configuredKnowledge(
  atlas: Atlas,
  config: CodeAtlasV2Config | undefined,
  selectedSymbols: readonly AtlasSymbol[],
): {
  constraints: ChangeContextConstraint[];
  invariants: ChangeContextInvariant[];
  commands: ChangeValidationCommand[];
  canonicalNameBySymbolId: Map<string, string>;
} {
  const canonicalNameBySymbolId = new Map<string, string>();
  if (config === undefined) return { constraints: [], invariants: [], commands: [], canonicalNameBySymbolId };
  const evidenceIds = configEvidenceIds(atlas);
  const resolve = (selector: string): AtlasSymbol | undefined => {
    const normalized = selector.toLocaleLowerCase();
    const matches = atlas.symbols.filter((symbol) => symbol.id === selector ||
      symbol.name.toLocaleLowerCase() === normalized ||
      symbol.qualified_name?.toLocaleLowerCase() === normalized);
    return matches.length === 1 ? matches[0] : undefined;
  };
  for (const canonical of config.knowledge.canonical_names) {
    const symbol = resolve(canonical.symbol);
    if (symbol !== undefined) canonicalNameBySymbolId.set(symbol.id, canonical.name);
  }
  if (evidenceIds.length === 0) return { constraints: [], invariants: [], commands: [], canonicalNameBySymbolId };
  const selectedFiles = [...new Set(selectedSymbols.flatMap((symbol) => symbol.file ?? []))];
  const ownerMatches = config.knowledge.owners.filter((owner) => {
    const matchers = owner.include.map((pattern) => picomatch(pattern, { dot: true }));
    return selectedFiles.some((file) => matchers.some((matches) => matches(file)));
  });
  const constraints: ChangeContextConstraint[] = [
    ...ownerMatches.map((owner) => ({
      id: `knowledge-owner:${owner.id}`,
      kind: "knowledge_owner" as const,
      summary: `${owner.id} is owned by ${owner.owner}: ${owner.purpose}`,
      evidence_ids: evidenceIds,
    })),
    ...config.architecture.rules.filter((rule) =>
      selectedSymbols.some((symbol) => selectorMatchesSymbol(atlas, symbol, rule.source))
    ).map((rule) => ({
      id: `architecture-rule:${rule.id}`,
      kind: "architecture_rule" as const,
      summary: rule.description,
      evidence_ids: evidenceIds,
    })),
  ];
  const invariants = config.knowledge.invariants.filter((invariant) => {
    const matchers = invariant.applies_to.map((pattern) => picomatch(pattern, { dot: true }));
    return selectedFiles.some((file) => matchers.some((matches) => matches(file)));
  }).map((invariant): ChangeContextInvariant => ({
    id: invariant.id,
    statement: invariant.statement,
    source: "human_config",
    evidence_ids: evidenceIds,
  }));
  const commands = ownerMatches.flatMap((owner): ChangeValidationCommand[] => owner.validation_command === null ? [] : [{
    id: `knowledge-validation:${owner.id}`,
    command: owner.validation_command,
    purpose: "check",
    source_file: ".codeatlas.yml",
    evidence_ids: evidenceIds,
  }]);
  return { constraints, invariants, commands, canonicalNameBySymbolId };
}

function resolutionGaps(
  atlas: Atlas,
  relevantIds: ReadonlySet<string>,
  taskTerms: readonly string[],
): ChangeContextGap[] {
  const normalizedTaskTerms = new Set(taskTerms.map((term) => term.toLocaleLowerCase()));
  return atlas.resolution_issues.flatMap((issue): ChangeContextGap[] => {
    if (!relevantIds.has(issue.source_id) && !issue.candidate_ids.some((id) => relevantIds.has(id))) {
      return [];
    }
    const referenceTerms = (issue.reference_name ?? "").toLocaleLowerCase()
      .split(/[^\p{L}\p{N}_$-]+/u)
      .filter(Boolean);
    const namedByTask = referenceTerms.some((term) => normalizedTaskTerms.has(term));
    const resolvesToRelevantCandidate = issue.candidate_ids.some((id) => relevantIds.has(id));
    if (["reference", "reflection"].includes(issue.reference_kind) &&
      !namedByTask && !resolvesToRelevantCandidate) return [];
    const code = issue.reason === "dynamic_relationship" ? "dynamic_relationship"
      : issue.reason === "unsupported_framework" ? "unsupported_coverage"
      : "unresolved_reference";
    return [{
      code,
      message: `${issue.reference_kind} ${issue.reference_name ?? issue.reference_hash} is ${issue.reason.replaceAll("_", " ")}.`,
      target: issue.reference_name,
      candidate_ids: issue.candidate_ids,
      evidence_ids: issue.evidence_ids,
    }];
  });
}

function selectedResolutionIds(
  candidates: readonly ChangeCandidate[],
  paths: readonly ChangeContextPath[],
  tests: readonly ChangeContextTest[],
  contracts: readonly ChangeContextContract[],
): Set<string> {
  return new Set([
    ...candidates.map((candidate) => candidate.symbol.id),
    ...paths.slice(0, 12).flatMap((path) => path.symbol_ids),
    ...tests.map((test) => test.symbol.id),
    ...contracts.map((contract) => contract.symbol.id),
  ]);
}

function fallbackCandidates(atlas: Atlas): AtlasSymbol[] {
  const entrypoints = new Set(atlas.entrypoint_ids);
  return atlas.symbols
    .filter((symbol) => symbolRef(symbol) !== null && isPrimaryArchitectureSymbol(symbol))
    .sort((left, right) =>
      Number(entrypoints.has(right.id)) - Number(entrypoints.has(left.id)) ||
      Number(right.visibility === "public") - Number(left.visibility === "public") ||
      right.confidence - left.confidence ||
      left.id.localeCompare(right.id)
    )
    .slice(0, 8);
}

function collectEvidenceIds(candidate: ChangeCandidate): string[] {
  return [...new Set([
    ...candidate.symbol.evidence_ids,
    ...candidate.supporting_paths.flatMap((path) => path.evidence_ids),
  ])];
}

function diversifyRankedCandidates(
  ranked: readonly ReturnType<typeof rankChangeCandidates>[number][],
  symbolById: ReadonlyMap<string, AtlasSymbol>,
  limit: number,
): ReturnType<typeof rankChangeCandidates> {
  const selected: ReturnType<typeof rankChangeCandidates> = [];
  const selectedIds = new Set<string>();
  const files = new Set<string>();
  for (const item of ranked) {
    const file = symbolById.get(item.symbolId)?.file;
    if (file === null || file === undefined || files.has(file)) continue;
    selected.push(item);
    selectedIds.add(item.symbolId);
    files.add(file);
    if (selected.length >= Math.min(6, limit)) break;
  }
  for (const item of ranked) {
    if (selectedIds.has(item.symbolId)) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function compileChangeContextFromAtlas(
  atlas: Atlas,
  repositoryRoot: string,
  snapshot: ContextPlannerSnapshot,
  task: string,
  options: CompileChangeContextOptions = {},
  resources: ChangeContextResources = {},
): ChangeContext {
  const trimmedTask = task.trim();
  if (trimmedTask === "") {
    throw new CodeAtlasError("A change-context task is required.", {
      code: "invalid_argument",
      recoverable: true,
      nextActions: ["Describe the intended change or use the CLI --diff option."],
    });
  }
  const intent = classifyChangeTask(trimmedTask, atlas);
  const changedSymbolIds = new Set(atlas.git_changes.flatMap((change) => change.symbol_ids));
  const ftsQuery = ftsTaskQuery(intent);
  const fts = ftsQuery === null ? [] : resources.queryStore === undefined
    ? ftsCandidates(repositoryRoot, ftsQuery)
    : resources.queryStore.searchSymbols(intent.terms.join(" "), 100).items;
  const projection = resources.projection ?? createAtlasProjection(atlas);
  const preliminaryKnowledge = configuredKnowledge(atlas, resources.v2Config, []);
  const ranked = rankChangeCandidates(atlas, intent, {
    fts,
    changedSymbolIds,
    prioritizeChangedSymbols: options.gitBase !== undefined ||
      /\b(?:current|diff|changes?|review|working[- ]tree)\b/iu.test(trimmedTask),
    searchTextBySymbolId: projection.searchTextBySymbolId,
    canonicalNameBySymbolId: preliminaryKnowledge.canonicalNameBySymbolId,
  });
  const symbolById = projection.symbolById;
  let selectedSymbols = diversifyRankedCandidates(ranked, projection.symbolById, 12).flatMap((item) => {
    const symbol = symbolById.get(item.symbolId);
    return symbol === undefined ? [] : [{ symbol, ranked: item }];
  });
  const hasExplicitTarget = intent.explicit_symbols.length > 0 || intent.explicit_files.length > 0 ||
    intent.explicit_endpoints.length > 0 || intent.explicit_domains.length > 0;
  const hasSpecificTerm = intent.terms.some((term) => !GENERIC_TASK_TERMS.has(term));
  const underspecified = !hasExplicitTarget && !hasSpecificTerm;
  if (underspecified || (selectedSymbols.length === 0 && intent.kind === "architecture")) {
    const fallback = fallbackCandidates(atlas);
    const known = new Set(selectedSymbols.map((item) => item.symbol.id));
    selectedSymbols = [
      ...selectedSymbols,
      ...fallback.filter((symbol) => !known.has(symbol.id)).map((symbol) => ({
        symbol,
        ranked: { symbolId: symbol.id, score: 1, reasons: ["architecture fallback"], targetResolution: null },
      })),
    ].slice(0, 12);
  }

  const verifiedPaths: ChangeContextPath[] = [];
  const potentialPaths: ChangeContextPath[] = [];
  const candidates: ChangeCandidate[] = [];
  const relevantIds = new Set<string>();
  for (const { symbol, ranked: ranking } of selectedSymbols) {
    const reference = symbolRef(symbol);
    if (reference === null) continue;
    const impact = describeImpact(atlas, symbol.id, { depth: 4, limit: 30 });
    const verified = [...impact.paths, ...impact.dependency_paths].map(contextPath).slice(0, 5);
    const potential = [
      ...(impact.potential_paths ?? []),
      ...(impact.potential_dependency_paths ?? []),
    ].map(contextPath).slice(0, 5);
    for (const id of [symbol.id, ...verified.flatMap((path) => path.symbol_ids), ...potential.flatMap((path) => path.symbol_ids)]) {
      relevantIds.add(id);
    }
    verifiedPaths.push(...verified);
    potentialPaths.push(...potential);
    const candidate: ChangeCandidate = {
      symbol: reference,
      retrieval_reasons: ranking.reasons,
      recommendation: {
        fact_class: "inference",
        action: ["bug_fix", "feature", "refactoring", "test_change"].includes(intent.kind)
          ? "modify"
          : "inspect",
        rationale: "Task vocabulary, structural role, and bounded graph reach make this a useful starting point.",
        confidence: Number(Math.min(1, 0.45 + Math.log10(Math.max(1, ranking.score)) / 6).toFixed(3)),
      },
      supporting_paths: [...verified, ...potential].slice(0, 1).map((path) => ({
        ...path,
        symbol_ids: path.symbol_ids.slice(0, 2),
        relationship_ids: path.relationship_ids.slice(0, 1),
        evidence_ids: path.evidence_ids.slice(0, 1),
      })),
      evidence_ids: [],
    };
    candidate.evidence_ids = collectEvidenceIds(candidate);
    candidates.push(candidate);
  }

  const allPaths = uniquePaths([...verifiedPaths, ...potentialPaths])
    .filter((path) => path.evidence_ids.length > 0);
  const flows = atlas.flows
    .filter((flow) =>
      relevantIds.has(flow.entrypoint_id) || flow.steps.some((step) => relevantIds.has(step.symbol_id))
    )
    .map(flowSlice)
    .filter((flow) => flow.evidence_ids.length > 0)
    .slice(0, 12);
  const contractSymbols = atlas.symbols.filter((symbol) =>
    relevantIds.has(symbol.id) && CONTRACT_KINDS.has(symbol.kind) && symbolRef(symbol) !== null
  );
  const contracts = contractSymbols.map((symbol): ChangeContextContract => ({
    symbol: symbolRef(symbol)!,
    contract_kind: CONTRACT_KINDS.get(symbol.kind)!,
    evidence_ids: symbol.evidence_ids,
  })).slice(0, 20);
  const impactedIds = new Set(allPaths
    .filter((item) => item.classification === "verified")
    .flatMap((item) => item.symbol_ids));
  const selectedCandidateIds = new Set(candidates.map((candidate) => candidate.symbol.id));
  const verifiedTestPaths = allPaths.filter((path) => path.classification === "verified");
  const ftsPosition = new Map(fts.map((item, index) => [item.id, index]));
  const testCandidates = atlas.symbols.flatMap((symbol): Array<{
    test: ChangeContextTest;
    taskScore: number;
    relationshipScore: number;
  }> => {
    const testScope = symbolArchitecturalScope(symbol);
    const executableTestSymbol = ["function", "method", "class"].includes(symbol.kind);
    if (testScope !== "test" || symbolRef(symbol) === null ||
      (symbol.kind !== "test" && !executableTestSymbol)) {
      return [];
    }
    const taskText = `${symbol.name} ${symbol.qualified_name ?? ""} ${symbol.file ?? ""}`
      .toLocaleLowerCase();
    const ftsRank = ftsPosition.get(symbol.id);
    const taskScore = intent.terms.filter((term) => term.length >= 3 && taskText.includes(term)).length * 100 +
      (ftsRank === undefined ? 0 : Math.max(1, 100 - ftsRank));
    const taskMatch = fts.some((item) => item.id === symbol.id) || taskScore > 0;
    const supportingPaths = verifiedTestPaths.filter((path) =>
      path.symbol_ids.includes(symbol.id) && path.symbol_ids.some((id) => selectedCandidateIds.has(id))
    );
    const direct = supportingPaths.some((item) => item.symbol_ids.length === 2);
    const impacted = supportingPaths.length > 0 || impactedIds.has(symbol.id);
    if (!impacted && !taskMatch) return [];
    return [{
      test: {
        symbol: symbolRef(symbol)!,
        relationship: direct ? "direct" : impacted ? "impacted" : "task_match",
        evidence_ids: [...new Set([
          ...symbol.evidence_ids,
          ...supportingPaths.slice(0, 2).flatMap((item) => item.evidence_ids),
        ])],
      },
      taskScore,
      relationshipScore: direct ? 2 : impacted ? 1 : 0,
    }];
  }).sort((left, right) =>
    right.relationshipScore - left.relationshipScore ||
    right.taskScore - left.taskScore ||
    Number(right.test.symbol.kind !== "test") - Number(left.test.symbol.kind !== "test") ||
    left.test.symbol.id.localeCompare(right.test.symbol.id)
  );
  const seenTestFiles = new Set<string>();
  const tests = testCandidates.filter(({ test }) => {
    if (seenTestFiles.has(test.symbol.file)) return false;
    seenTestFiles.add(test.symbol.file);
    return true;
  }).slice(0, 20).map(({ test }) => test);

  const gaps: ChangeContextGap[] = [
    ...ambiguousGaps(atlas, intent.explicit_symbols),
    ...(underspecified ? [{
      code: "insufficient_task_specificity" as const,
      message: "The task names no symbol, file, endpoint, or domain; candidates are architecture starting points rather than a resolved edit target.",
      target: null,
      candidate_ids: candidates.map((candidate) => candidate.symbol.id),
      evidence_ids: [],
    }] : []),
    ...(candidates.length === 0 ? [{
      code: "unsupported_coverage" as const,
      message: "No source-backed candidate is present in the canonical IR; use native file search and inspect language/framework coverage.",
      target: null,
      candidate_ids: [],
      evidence_ids: [],
    }] : []),
    ...resolutionGaps(
      atlas,
      selectedResolutionIds(candidates, allPaths, tests, contracts),
      intent.terms,
    ),
  ];
  const limitations = [
    ...(atlas.statistics.files === 0 ? ["No supported source files were indexed."] : []),
    ...(atlas.resolution_issues.length > 0
      ? [`${atlas.resolution_issues.length} resolution issues remain explicit.`]
      : []),
    ...(potentialPaths.length > 0 ? ["Potential relationships are separated from verified paths."] : []),
  ];
  const evidenceById = projection.evidenceById;
  const validEvidence = (ids: readonly string[]): AtlasEvidence[] => ids.flatMap((id) => {
    const evidence = evidenceById.get(id);
    return evidence === undefined ? [] : [evidence];
  });
  const editLocations: ChangeContext["edit_locations"] = candidates.map((candidate) => ({
    symbol_id: candidate.symbol.id,
    file: candidate.symbol.file,
    start_line: candidate.symbol.location.start_line,
    end_line: candidate.symbol.location.end_line,
    action: candidate.recommendation.action,
    confidence: candidate.recommendation.confidence,
    evidence_ids: candidate.symbol.evidence_ids,
  }));
  const knowledge = configuredKnowledge(atlas, resources.v2Config, selectedSymbols.map((item) => item.symbol));
  const constraints = uniqueById([...knowledge.constraints, ...relevantConstraints(atlas, relevantIds)]);
  const invariants: ChangeContextInvariant[] = [
    ...knowledge.invariants,
    ...constraints.map((constraint) => ({
      id: constraint.id,
      statement: constraint.summary,
      source: constraint.kind === "decision" ? "decision" as const : "architecture" as const,
      evidence_ids: constraint.evidence_ids,
    })),
    ...contracts.map((contract) => ({
      id: contract.symbol.id,
      statement: `Preserve the ${contract.contract_kind} contract ${contract.symbol.qualified_name ?? contract.symbol.name}.`,
      source: "contract" as const,
      evidence_ids: contract.evidence_ids,
    })),
  ];
  const commands = uniqueById([...knowledge.commands, ...validationCommands(atlas, repositoryRoot)]);
  if (commands.length === 0) {
    gaps.push({
      code: "validation_unavailable",
      message: "No repository or owner validation command is available for this task; inspect the owning package before editing.",
      target: null,
      candidate_ids: candidates.map((candidate) => candidate.symbol.id),
      evidence_ids: [],
    });
  }
  const checklist = verificationChecklist({
    edits: editLocations,
    contracts,
    invariants,
    tests,
    commands,
    gaps,
  });
  const collectionEvidenceIds = [...new Set([
    ...candidates.flatMap((item) => item.evidence_ids),
    ...editLocations.flatMap((item) => item.evidence_ids),
    ...allPaths.flatMap((item) => item.evidence_ids),
    ...flows.flatMap((item) => item.evidence_ids),
    ...contracts.flatMap((item) => item.evidence_ids),
    ...tests.flatMap((item) => item.evidence_ids),
    ...constraints.flatMap((item) => item.evidence_ids),
    ...invariants.flatMap((item) => item.evidence_ids),
    ...commands.flatMap((item) => item.evidence_ids),
    ...checklist.flatMap((item) => item.evidence_ids),
    ...gaps.flatMap((item) => item.evidence_ids),
  ])];
  const packet = fitChangeContextToBudget({
    schema_version: CHANGE_CONTEXT_SCHEMA_VERSION,
    snapshot,
    task: trimmedTask,
    intent,
    summary: candidates.length === 0
      ? "The indexed graph cannot resolve a source-backed change location for this task."
      : "The brief ranks source-backed starting points and keeps recommendations separate from graph facts.",
    coverage: {
      indexed_files: atlas.statistics.files,
      indexed_symbols: atlas.statistics.symbols,
      languages: [...new Set(atlas.symbols.flatMap((symbol) => symbol.language ?? []))].sort(),
      resolution_issues: atlas.resolution_issues.length,
      limitations,
    },
    content_trust: "untrusted_repository_content",
  }, {
    change_candidates: candidates,
    edit_locations: editLocations,
    verified_paths: allPaths.filter((item) => item.classification === "verified"),
    potential_paths: allPaths.filter((item) => item.classification === "potential"),
    relevant_flows: flows,
    affected_contracts: contracts,
    relevant_tests: tests,
    constraints,
    invariants,
    validation_commands: commands,
    verification_checklist: checklist,
    gaps: uniqueById(gaps.map((gap, index) => ({ ...gap, id: `${gap.code}:${gap.target ?? index}` })))
      .map(({ id: _id, ...gap }) => gap),
  }, validEvidence(collectionEvidenceIds), {
    requested: Math.max(1, options.budget ?? 6_000),
    format: options.format ?? "json",
    envelopeReserve: Math.max(0, options.envelopeReserve ?? 0),
  });
  const groundingErrors = validateChangeContextGrounding(packet);
  if (groundingErrors.length > 0) {
    throw new CodeAtlasError(`Change-context grounding failed: ${groundingErrors.join(" ")}`, {
      code: "invalid_context_packet",
      recoverable: false,
      details: { errors: groundingErrors },
    });
  }
  return packet;
}

export async function compileChangeContext(
  task: string,
  startPath = process.cwd(),
  options: CompileChangeContextOptions = {},
): Promise<ChangeContext> {
  if (options.gitBase !== undefined) {
    const atlas = await buildAtlasAtGitHead(startPath, options.gitBase, "HEAD", { snapshot: false });
    const current = await architectureService.load(startPath);
    const v2Config = await loadV2Config(current.repositoryRoot);
    return compileChangeContextFromAtlas(atlas, current.repositoryRoot, {
      id: atlas.snapshot.id,
      fingerprint: current.fingerprint,
      generations: current.status.generations,
    }, task, options, { projection: createAtlasProjection(atlas), v2Config });
  }
  const context = await architectureService.load(startPath);
  const v2Config = await loadV2Config(context.repositoryRoot);
  return compileChangeContextFromAtlas(context.atlas, context.repositoryRoot, {
    id: context.atlas.snapshot.id,
    fingerprint: context.fingerprint,
    generations: context.status.generations,
  }, task, options, { projection: context.projection, queryStore: context.queryStore, v2Config });
}
