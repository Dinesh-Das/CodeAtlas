import type { Atlas } from "../ir/models.js";

export interface ArchitectureDiff {
  old_snapshot: string;
  new_snapshot: string;
  symbols: {
    added: string[];
    removed: string[];
    modified: string[];
    moved: string[];
    moved_pairs: Array<{ previous_id: string; current_id: string }>;
  };
  relationships: {
    added: string[];
    removed: string[];
  };
  dependencies: {
    added: string[];
    removed: string[];
  };
  domains: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  entrypoints: {
    added: string[];
    removed: string[];
  };
  apis: {
    added: string[];
    removed: string[];
  };
  cycles: {
    added: string[][];
    resolved: string[][];
  };
  centrality: {
    changed: Array<{
      symbol_id: string;
      previous: number;
      current: number;
      delta: number;
    }>;
  };
  rule_violations: {
    introduced: string[];
    resolved: string[];
  };
}

const NON_DEPENDENCY_EDGE_TYPES = new Set([
  "CONTAINS",
  "EXPORTS",
  "BELONGS_TO_FEATURE",
  "BELONGS_TO_DOMAIN",
  "RENAMED_FROM",
  "ROUTE_PREFIX",
]);

function movementKey(symbol: Atlas["symbols"][number]): string {
  return [
    symbol.kind,
    symbol.language ?? "",
    symbol.qualified_name ?? symbol.name,
    symbol.signature ?? "",
  ].join("\0");
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort((a, b) => a.localeCompare(b));
}

function dependencyIds(atlas: Atlas): Set<string> {
  return new Set(atlas.relationships
    .filter((edge) => !NON_DEPENDENCY_EDGE_TYPES.has(edge.type))
    .map((edge) => edge.id));
}

function dependencyCycles(atlas: Atlas): Map<string, string[]> {
  const outgoing = new Map<string, string[]>();
  for (const edge of atlas.relationships) {
    if (NON_DEPENDENCY_EDGE_TYPES.has(edge.type)) continue;
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  for (const targets of outgoing.values()) targets.sort((left, right) => left.localeCompare(right));

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles = new Map<string, string[]>();

  const visit = (id: string): void => {
    indexes.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of outgoing.get(id) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indexes.get(target)!));
      }
    }

    if (lowLinks.get(id) !== indexes.get(id)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort((left, right) => left.localeCompare(right));
    const selfCycle = component.length === 1 && (outgoing.get(component[0]!) ?? []).includes(component[0]!);
    if (component.length > 1 || selfCycle) cycles.set(component.join("\0"), component);
  };

  const nodeIds = new Set<string>();
  for (const [source, targets] of outgoing) {
    nodeIds.add(source);
    for (const target of targets) nodeIds.add(target);
  }
  for (const id of [...nodeIds].sort((left, right) => left.localeCompare(right))) {
    if (!indexes.has(id)) visit(id);
  }
  return cycles;
}

function centralityChanges(oldAtlas: Atlas, newAtlas: Atlas): ArchitectureDiff["centrality"]["changed"] {
  const oldScores = new Map(oldAtlas.impact.scores.map((score) => [score.symbol_id, score.centrality]));
  const newScores = new Map(newAtlas.impact.scores.map((score) => [score.symbol_id, score.centrality]));
  return [...oldScores.entries()].flatMap(([symbolId, previous]) => {
    const current = newScores.get(symbolId);
    return current !== undefined && current !== previous
      ? [{ symbol_id: symbolId, previous, current, delta: current - previous }]
      : [];
  }).sort((left, right) => left.symbol_id.localeCompare(right.symbol_id));
}

export function compareArchitecture(oldAtlas: Atlas, newAtlas: Atlas): ArchitectureDiff {
  const oldSymbols = new Map(oldAtlas.symbols.map((symbol) => [symbol.id, symbol]));
  const newSymbols = new Map(newAtlas.symbols.map((symbol) => [symbol.id, symbol]));
  const oldIds = new Set(oldSymbols.keys());
  const newIds = new Set(newSymbols.keys());
  const common = [...oldIds].filter((id) => newIds.has(id));
  const moved = common.filter((id) => oldSymbols.get(id)!.file !== newSymbols.get(id)!.file);
  const modified = common.filter((id) => {
    const oldSymbol = oldSymbols.get(id)!;
    const newSymbol = newSymbols.get(id)!;
    return oldSymbol.signature !== newSymbol.signature ||
      oldSymbol.content_hash !== newSymbol.content_hash ||
      JSON.stringify(oldSymbol.metadata) !== JSON.stringify(newSymbol.metadata) ||
      oldSymbol.confidence !== newSymbol.confidence;
  });
  const oldRelationships = new Set(oldAtlas.relationships.map((edge) => edge.id));
  const newRelationships = new Set(newAtlas.relationships.map((edge) => edge.id));
  const oldDependencies = dependencyIds(oldAtlas);
  const newDependencies = dependencyIds(newAtlas);
  const oldDomains = new Map(oldAtlas.domains.map((domain) => [domain.id, domain]));
  const newDomains = new Map(newAtlas.domains.map((domain) => [domain.id, domain]));
  const oldDomainIds = new Set(oldDomains.keys());
  const newDomainIds = new Set(newDomains.keys());
  const changedDomains = [...oldDomainIds].filter((id) => {
    const next = newDomains.get(id);
    return next !== undefined && JSON.stringify(oldDomains.get(id)!.member_ids) !== JSON.stringify(next.member_ids);
  }).sort((a, b) => a.localeCompare(b));
  const rawAdded = difference(newIds, oldIds);
  const rawRemoved = difference(oldIds, newIds);
  const removedByKey = new Map<string, string[]>();
  for (const id of rawRemoved) {
    const key = movementKey(oldSymbols.get(id)!);
    const bucket = removedByKey.get(key) ?? [];
    bucket.push(id);
    removedByKey.set(key, bucket);
  }
  const movedPairs: Array<{ previous_id: string; current_id: string }> = [];
  const matchedAdded = new Set<string>();
  const matchedRemoved = new Set<string>();
  for (const id of rawAdded) {
    const symbol = newSymbols.get(id)!;
    const candidates = removedByKey.get(movementKey(symbol)) ?? [];
    const previousId = candidates.find((candidate) =>
      !matchedRemoved.has(candidate) && oldSymbols.get(candidate)!.file !== symbol.file,
    );
    if (previousId === undefined) continue;
    matchedAdded.add(id);
    matchedRemoved.add(previousId);
    movedPairs.push({ previous_id: previousId, current_id: id });
  }
  for (const id of moved) movedPairs.push({ previous_id: id, current_id: id });
  movedPairs.sort((left, right) =>
    `${left.previous_id}\0${left.current_id}`.localeCompare(`${right.previous_id}\0${right.current_id}`),
  );
  const oldCycles = dependencyCycles(oldAtlas);
  const newCycles = dependencyCycles(newAtlas);
  const oldApiIds = new Set(oldAtlas.symbols.filter((symbol) => symbol.kind === "endpoint").map((symbol) => symbol.id));
  const newApiIds = new Set(newAtlas.symbols.filter((symbol) => symbol.kind === "endpoint").map((symbol) => symbol.id));
  const oldViolationIds = new Set(oldAtlas.rule_violations.map((violation) => violation.id));
  const newViolationIds = new Set(newAtlas.rule_violations.map((violation) => violation.id));
  return {
    old_snapshot: oldAtlas.snapshot.id,
    new_snapshot: newAtlas.snapshot.id,
    symbols: {
      added: rawAdded.filter((id) => !matchedAdded.has(id)),
      removed: rawRemoved.filter((id) => !matchedRemoved.has(id)),
      modified: modified.sort((a, b) => a.localeCompare(b)),
      moved: [...new Set([...moved, ...movedPairs.map((pair) => pair.current_id)])]
        .sort((a, b) => a.localeCompare(b)),
      moved_pairs: movedPairs,
    },
    relationships: {
      added: difference(newRelationships, oldRelationships),
      removed: difference(oldRelationships, newRelationships),
    },
    dependencies: {
      added: difference(newDependencies, oldDependencies),
      removed: difference(oldDependencies, newDependencies),
    },
    domains: {
      added: difference(newDomainIds, oldDomainIds),
      removed: difference(oldDomainIds, newDomainIds),
      changed: changedDomains,
    },
    entrypoints: {
      added: difference(new Set(newAtlas.entrypoint_ids), new Set(oldAtlas.entrypoint_ids)),
      removed: difference(new Set(oldAtlas.entrypoint_ids), new Set(newAtlas.entrypoint_ids)),
    },
    apis: {
      added: difference(newApiIds, oldApiIds),
      removed: difference(oldApiIds, newApiIds),
    },
    cycles: {
      added: difference(new Set(newCycles.keys()), new Set(oldCycles.keys())).map((key) => newCycles.get(key)!),
      resolved: difference(new Set(oldCycles.keys()), new Set(newCycles.keys())).map((key) => oldCycles.get(key)!),
    },
    centrality: {
      changed: centralityChanges(oldAtlas, newAtlas),
    },
    rule_violations: {
      introduced: difference(newViolationIds, oldViolationIds),
      resolved: difference(oldViolationIds, newViolationIds),
    },
  };
}
