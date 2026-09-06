import { describeImpact } from "../analysis/impact.js";
import { isPrimaryArchitectureSymbol } from "../analysis/scope.js";
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
  type ChangeContextPath,
  type ChangeContextSymbolRef,
  type ChangeContextTest,
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
}

const TEST_PATTERN = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[^/]+$/iu;
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
]);

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
    if (documentKind !== "decision") return [];
    return [{
      id: symbol.id,
      kind: "decision",
      summary: `Architecture decision: ${symbol.name}`,
      evidence_ids: symbol.evidence_ids,
    }];
  });
  return uniqueById([...violations, ...decisions]).slice(0, 20);
}

function resolutionGaps(atlas: Atlas, relevantIds: ReadonlySet<string>): ChangeContextGap[] {
  return atlas.resolution_issues.flatMap((issue): ChangeContextGap[] => {
    if (!relevantIds.has(issue.source_id) && !issue.candidate_ids.some((id) => relevantIds.has(id))) {
      return [];
    }
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

export function compileChangeContextFromAtlas(
  atlas: Atlas,
  repositoryRoot: string,
  snapshot: ContextPlannerSnapshot,
  task: string,
  options: Omit<CompileChangeContextOptions, "gitBase"> = {},
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
  const ranked = rankChangeCandidates(atlas, trimmedTask, intent, {
    fts,
    changedSymbolIds,
    searchTextBySymbolId: projection.searchTextBySymbolId,
  });
  const symbolById = projection.symbolById;
  let selectedSymbols = ranked.slice(0, 12).flatMap((item) => {
    const symbol = symbolById.get(item.symbolId);
    return symbol === undefined ? [] : [{ symbol, ranked: item }];
  });
  const hasExplicitTarget = intent.explicit_symbols.length > 0 || intent.explicit_files.length > 0 ||
    intent.explicit_endpoints.length > 0 || intent.explicit_domains.length > 0;
  const hasSpecificTerm = intent.terms.some((term) => !GENERIC_TASK_TERMS.has(term));
  const underspecified = !hasExplicitTarget && !hasSpecificTerm;
  if (selectedSymbols.length === 0 || underspecified) {
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
  const impactedIds = new Set(allPaths.flatMap((item) => item.symbol_ids));
  const testCandidates = atlas.symbols.flatMap((symbol): ChangeContextTest[] => {
    const executableTestSymbol = TEST_PATTERN.test(symbol.file ?? "") &&
      ["function", "method", "class"].includes(symbol.kind);
    if (symbolRef(symbol) === null || (symbol.kind !== "test" && !executableTestSymbol)) {
      return [];
    }
    const taskMatch = fts.some((item) => item.id === symbol.id);
    if (!relevantIds.has(symbol.id) && !impactedIds.has(symbol.id) && !taskMatch) return [];
    return [{
      symbol: symbolRef(symbol)!,
      relationship: relevantIds.has(symbol.id) ? "direct" : impactedIds.has(symbol.id) ? "impacted" : "task_match",
      evidence_ids: symbol.evidence_ids,
    }];
  }).sort((left, right) =>
    Number(right.relationship !== "task_match") - Number(left.relationship !== "task_match") ||
    Number(right.symbol.kind !== "test") - Number(left.symbol.kind !== "test") ||
    left.symbol.id.localeCompare(right.symbol.id)
  );
  const seenTestFiles = new Set<string>();
  const tests = testCandidates.filter((test) => {
    if (seenTestFiles.has(test.symbol.file)) return false;
    seenTestFiles.add(test.symbol.file);
    return true;
  }).slice(0, 20);

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
    ...resolutionGaps(atlas, relevantIds),
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
  const collectionEvidenceIds = [...new Set([
    ...candidates.flatMap((item) => item.evidence_ids),
    ...allPaths.flatMap((item) => item.evidence_ids),
    ...flows.flatMap((item) => item.evidence_ids),
    ...contracts.flatMap((item) => item.evidence_ids),
    ...tests.flatMap((item) => item.evidence_ids),
    ...gaps.flatMap((item) => item.evidence_ids),
  ])];
  const constraints = relevantConstraints(atlas, relevantIds);
  collectionEvidenceIds.push(...constraints.flatMap((item) => item.evidence_ids));
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
    verified_paths: allPaths.filter((item) => item.classification === "verified"),
    potential_paths: allPaths.filter((item) => item.classification === "potential"),
    relevant_flows: flows,
    affected_contracts: contracts,
    relevant_tests: tests,
    constraints,
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
    return compileChangeContextFromAtlas(atlas, current.repositoryRoot, {
      id: atlas.snapshot.id,
      fingerprint: current.fingerprint,
      generations: current.status.generations,
    }, task, options, { projection: createAtlasProjection(atlas) });
  }
  const context = await architectureService.load(startPath);
  return compileChangeContextFromAtlas(context.atlas, context.repositoryRoot, {
    id: context.atlas.snapshot.id,
    fingerprint: context.fingerprint,
    generations: context.status.generations,
  }, task, options, { projection: context.projection, queryStore: context.queryStore });
}
