import { sha256 } from "../core/hashing.js";
import type { ArchitectureRule, Atlas, AtlasRelationship, AtlasSymbol, RuleViolation } from "../ir/models.js";

function layer(symbol: AtlasSymbol): string | null {
  const value = `${symbol.qualified_name ?? ""} ${symbol.file ?? ""} ${symbol.name}`.toLocaleLowerCase();
  for (const candidate of ["controller", "service", "repository", "model", "api", "worker", "test"] as const) {
    if (value.includes(candidate)) return candidate;
  }
  return null;
}

function matchesSelector(atlas: Atlas, symbol: AtlasSymbol, selector: Record<string, string>): boolean {
  const domainById = new Map(atlas.domains.map((domain) => [domain.id, domain.name.toLocaleLowerCase()]));
  return Object.entries(selector).every(([key, expected]) => {
    const value = expected.toLocaleLowerCase();
    if (key === "kind") return symbol.kind.toLocaleLowerCase() === value;
    if (key === "layer") return layer(symbol) === value;
    if (key === "domain") return symbol.domain_ids.some((id) => domainById.get(id) === value);
    if (key === "matches_path") return (symbol.file ?? "").toLocaleLowerCase().includes(value);
    return String(symbol.metadata[key] ?? "").toLocaleLowerCase() === value;
  });
}

function targetSelector(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function violation(rule: ArchitectureRule, source: AtlasSymbol, target: AtlasSymbol | null, path: AtlasRelationship[]): RuleViolation {
  const relationshipIds = path.map((edge) => edge.id);
  const evidenceIds = [...new Set([
    ...source.evidence_ids,
    ...(target?.evidence_ids ?? []),
    ...path.flatMap((edge) => edge.evidence_ids),
  ])];
  return {
    id: `violation:${sha256(`${rule.id}:${source.id}:${target?.id ?? ""}:${relationshipIds.join(":")}`)}`,
    rule_id: rule.id,
    severity: rule.severity,
    source_id: source.id,
    target_id: target?.id ?? null,
    path: [source.id, ...path.map((edge) => edge.target)],
    relationship_ids: relationshipIds,
    evidence_ids: evidenceIds,
    message: `${source.qualified_name ?? source.name} violates ${rule.id}${target === null ? "" : ` via ${target.qualified_name ?? target.name}`}.`,
  };
}

function directViolations(atlas: Atlas, rule: ArchitectureRule, type: string, selector: Record<string, string>): RuleViolation[] {
  const symbols = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  return atlas.relationships.filter((edge) => edge.type === type).flatMap((edge) => {
    const source = symbols.get(edge.source);
    const target = symbols.get(edge.target);
    return source !== undefined && target !== undefined &&
      matchesSelector(atlas, source, rule.source) && matchesSelector(atlas, target, selector)
      ? [violation(rule, source, target, [edge])]
      : [];
  });
}

function pathViolations(atlas: Atlas, rule: ArchitectureRule, selector: Record<string, string>): RuleViolation[] {
  const symbols = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const outgoing = new Map<string, AtlasRelationship[]>();
  for (const edge of atlas.relationships) {
    if (["CONTAINS", "EXPORTS", "BELONGS_TO_DOMAIN", "BELONGS_TO_FEATURE"].includes(edge.type)) continue;
    const edges = outgoing.get(edge.source) ?? [];
    edges.push(edge);
    outgoing.set(edge.source, edges);
  }
  const unless = targetSelector(rule.forbid.unless_via);
  const results: RuleViolation[] = [];
  for (const source of atlas.symbols.filter((symbol) => matchesSelector(atlas, symbol, rule.source))) {
    const queue = [{ id: source.id, path: [] as AtlasRelationship[] }];
    const visited = new Set([source.id]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length >= 12) continue;
      for (const edge of outgoing.get(current.id) ?? []) {
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        const target = symbols.get(edge.target);
        if (target === undefined) continue;
        const nextPath = [...current.path, edge];
        if (unless !== null && nextPath.slice(0, -1).some((item) => {
          const candidate = symbols.get(item.target);
          return candidate !== undefined && matchesSelector(atlas, candidate, unless);
        })) continue;
        if (matchesSelector(atlas, target, selector)) {
          results.push(violation(rule, source, target, nextPath));
          break;
        }
        queue.push({ id: target.id, path: nextPath });
      }
    }
  }
  return results;
}

export function evaluateArchitectureRules(atlas: Atlas, rules: readonly ArchitectureRule[]): RuleViolation[] {
  const results: RuleViolation[] = [];
  const symbols = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  for (const rule of rules) {
    const forbid = rule.forbid;
    for (const [predicate, rawSelector] of Object.entries(forbid)) {
      const selector = targetSelector(rawSelector);
      if (selector === null) continue;
      if (predicate === "depends_on") results.push(...directViolations(atlas, rule, "DEPENDS_ON", selector));
      else if (predicate === "calls") results.push(...directViolations(atlas, rule, "CALLS", selector));
      else if (predicate === "imports") results.push(...directViolations(atlas, rule, "IMPORTS", selector));
      else if (predicate === "path_to") results.push(...pathViolations(atlas, rule, selector));
    }
    if (forbid.crosses_domain === true) {
      for (const edge of atlas.relationships) {
        if (["CONTAINS", "EXPORTS", "BELONGS_TO_DOMAIN", "BELONGS_TO_FEATURE"].includes(edge.type)) continue;
        const source = symbols.get(edge.source);
        const target = symbols.get(edge.target);
        if (source === undefined || target === undefined || !matchesSelector(atlas, source, rule.source)) continue;
        if (source.domain_ids.length === 0 || target.domain_ids.length === 0) continue;
        if (!source.domain_ids.some((id) => target.domain_ids.includes(id))) {
          results.push(violation(rule, source, target, [edge]));
        }
      }
    }
    const belongsTo = targetSelector(forbid.belongs_to);
    if (belongsTo !== null) {
      for (const source of atlas.symbols) {
        if (matchesSelector(atlas, source, rule.source) && matchesSelector(atlas, source, belongsTo)) {
          results.push(violation(rule, source, null, []));
        }
      }
    }
    if (typeof forbid.matches_path === "string") {
      const expected = forbid.matches_path.toLocaleLowerCase();
      for (const source of atlas.symbols) {
        if (matchesSelector(atlas, source, rule.source) && source.file?.toLocaleLowerCase().includes(expected)) {
          results.push(violation(rule, source, null, []));
        }
      }
    }
  }
  return [...new Map(results.map((item) => [item.id, item])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}
