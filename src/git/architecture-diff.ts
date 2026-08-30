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
  domains: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  entrypoints: {
    added: string[];
    removed: string[];
  };
}

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
    domains: {
      added: difference(newDomainIds, oldDomainIds),
      removed: difference(oldDomainIds, newDomainIds),
      changed: changedDomains,
    },
    entrypoints: {
      added: difference(new Set(newAtlas.entrypoint_ids), new Set(oldAtlas.entrypoint_ids)),
      removed: difference(new Set(oldAtlas.entrypoint_ids), new Set(newAtlas.entrypoint_ids)),
    },
  };
}
