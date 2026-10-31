import { symbolSearchTerms } from "../analysis/simplification.js";
import { EvidenceExcerptReader } from "../ir/evidence.js";
import type {
  Atlas,
  AtlasDomain,
  AtlasEvidence,
  AtlasFlow,
  AtlasGitChange,
  AtlasRelationship,
  AtlasSymbol,
  ArchitectureRule,
  RuleViolation,
} from "../ir/models.js";
import type { CodeAtlasV2Config } from "../rules/types.js";
import type { AtlasRuntimeManifest } from "../storage/atlas-cache.js";
import type { QueryStore } from "../storage/query-store.js";

export interface TaskAtlasOptions {
  repositoryRoot: string;
  manifest: AtlasRuntimeManifest;
  queryStore: QueryStore;
  task: string;
  config?: CodeAtlasV2Config;
  maxSymbols?: number;
  maxRelationships?: number;
  includeExcerpts?: boolean;
}

const FILE_REFERENCE = /\b([\w@.+-]+(?:[/\\][\w@.+-]+)*\.[A-Za-z][A-Za-z0-9]*)\b/gu;
const CODE_REFERENCE = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\b/gu;

function evidenceIds(values: readonly unknown[]): string[] {
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const ids = (value as { evidence_ids?: unknown }).evidence_ids;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }))];
}

function relevantSection<T>(
  queryStore: QueryStore,
  section: string,
  limit: number,
  predicate: (item: T) => boolean,
): T[] {
  return queryStore.getSection<T>(section, limit).items.filter(predicate);
}

export async function loadTaskAtlas(options: TaskAtlasOptions): Promise<Atlas> {
  const maxSymbols = Math.max(50, Math.min(2_000, options.maxSymbols ?? 500));
  const maxRelationships = Math.max(100, Math.min(5_000, options.maxRelationships ?? 2_000));
  const taskTerms = new Set(symbolSearchTerms(options.task));
  const fileReferences = [...options.task.matchAll(FILE_REFERENCE)]
    .map((match) => (match[1] ?? "").replaceAll("\\", "/"));
  const codeReferences = [...options.task.matchAll(CODE_REFERENCE)]
    .map((match) => match[0])
    .filter((value) => /[a-z0-9][A-Z]|[_$:]/u.test(value));
  const canonicalReferences = (options.config?.knowledge.canonical_names ?? [])
    .filter((item) => symbolSearchTerms(item.name).some((term) => taskTerms.has(term)))
    .map((item) => item.symbol);
  const searchQueries = [...new Set([options.task, ...codeReferences, ...canonicalReferences])].slice(0, 20);
  const seedIds = new Set<string>();
  for (const query of searchQueries) {
    for (const item of options.queryStore.searchSymbols(query, maxSymbols).items) seedIds.add(item.id);
  }
  const entrypointSeeds = ["architecture", "flow", "journey", "mcp", "request"]
    .some((term) => taskTerms.has(term))
    ? options.queryStore.getSection<string>("entrypoint_ids", 1_000).items
    : [];
  for (const id of entrypointSeeds) seedIds.add(id);
  const symbolsById = new Map<string, AtlasSymbol>();
  const prioritizedSeedIds = [...new Set([...entrypointSeeds, ...seedIds])];
  for (const symbol of options.queryStore.getSymbols(prioritizedSeedIds, maxSymbols).items) {
    symbolsById.set(symbol.id, symbol);
  }
  const auxiliarySymbols = options.queryStore.getSymbolsByFiles(
    [...new Set([...fileReferences, "package.json", ".codeatlas.yml"])],
    maxSymbols,
  ).items;
  for (const symbol of auxiliarySymbols) {
    symbolsById.set(symbol.id, symbol);
  }

  const relationshipsById = new Map<string, AtlasRelationship>();
  let frontier = prioritizedSeedIds.filter((id) => symbolsById.has(id));
  const visited = new Set(frontier);
  for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
    const projected = options.queryStore.queryProjection({
      relationships: { symbolIds: frontier, direction: "both" },
      limit: maxRelationships,
    });
    const relationships = options.queryStore.getSectionItems<AtlasRelationship>(
      "relationships",
      projected.relationships.items.map((item) => item.id),
      maxRelationships,
    ).items;
    const nextIds = new Set<string>();
    for (const relationship of relationships) {
      if (relationshipsById.size >= maxRelationships) break;
      relationshipsById.set(relationship.id, relationship);
      for (const id of [relationship.source, relationship.target]) {
        if (!visited.has(id) && symbolsById.size + nextIds.size < maxSymbols) nextIds.add(id);
      }
    }
    for (const symbol of options.queryStore.getSymbols([...nextIds], maxSymbols - symbolsById.size).items) {
      symbolsById.set(symbol.id, symbol);
      visited.add(symbol.id);
    }
    frontier = [...nextIds].filter((id) => symbolsById.has(id));
    if (relationshipsById.size >= maxRelationships || symbolsById.size >= maxSymbols) break;
  }

  const symbolIds = new Set(symbolsById.keys());
  const domains = relevantSection<AtlasDomain>(options.queryStore, "domains", 500, (domain) =>
    domain.member_ids.some((id) => symbolIds.has(id))
  );
  const flows = relevantSection<AtlasFlow>(options.queryStore, "flows", 500, (flow) =>
    symbolIds.has(flow.entrypoint_id) || flow.steps.some((step) => symbolIds.has(step.symbol_id))
  );
  const ruleViolations = relevantSection<RuleViolation>(options.queryStore, "rule_violations", 1_000, (violation) =>
    symbolIds.has(violation.source_id) ||
    (violation.target_id !== null && symbolIds.has(violation.target_id)) ||
    violation.path.some((id) => symbolIds.has(id))
  );
  const gitChanges = relevantSection<AtlasGitChange>(options.queryStore, "git_changes", 1_000, (change) =>
    change.symbol_ids.some((id) => symbolIds.has(id))
  );
  const resolutionIssues = options.queryStore.getResolutionIssuesForSymbols([...symbolIds], 1_000).items;
  const rules = options.queryStore.getSection<ArchitectureRule>("rules", 500).items;
  const entrypointIds = options.queryStore.getSection<string>("entrypoint_ids", 1_000).items
    .filter((id) => symbolIds.has(id));
  const recordsWithEvidence: unknown[] = [
    ...auxiliarySymbols,
    ...symbolsById.values(),
    ...relationshipsById.values(),
    ...domains,
    ...flows,
    ...ruleViolations,
    ...gitChanges,
    ...resolutionIssues,
  ];
  const supportingFileEvidence = options.queryStore.getEvidenceByFiles(["package.json", ".codeatlas.yml"], 20).items;
  const persistedEvidence = options.queryStore.getSectionItems<AtlasEvidence>(
    "evidence",
    evidenceIds(recordsWithEvidence),
    2_500,
  ).items;
  const reader = new EvidenceExcerptReader(options.repositoryRoot);
  const selectedEvidence = [...new Map([...supportingFileEvidence, ...persistedEvidence]
    .map((item) => [item.id, item])).values()];
  const evidence = await Promise.all(selectedEvidence.map(async (item) => {
    if (options.includeExcerpts === false) return { ...item, excerpt: null };
    const excerpt = await reader.read(item.file, item.start_line, item.end_line);
    return { ...item, excerpt: excerpt.excerpt, excerpt_status: excerpt.status };
  }));

  return {
    schema_version: options.manifest.schema_version,
    generator: options.manifest.generator,
    project: options.manifest.project,
    snapshot: options.manifest.snapshot,
    statistics: options.manifest.statistics,
    symbols: [...symbolsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    relationships: [...relationshipsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    evidence,
    resolution_issues: resolutionIssues,
    domains,
    entrypoint_ids: entrypointIds,
    flows,
    control_flows: [],
    impact: { forward: {}, reverse: {}, scores: [] },
    git_changes: gitChanges,
    rules,
    rule_violations: ruleViolations,
    review_findings: [],
  };
}
