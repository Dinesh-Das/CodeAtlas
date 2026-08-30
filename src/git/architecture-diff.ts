import type { Atlas } from "../ir/models.js";

export interface ArchitectureDiff {
  old_snapshot: string;
  new_snapshot: string;
  symbols: {
    added: string[];
    removed: string[];
    modified: string[];
    moved: string[];
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
  return {
    old_snapshot: oldAtlas.snapshot.id,
    new_snapshot: newAtlas.snapshot.id,
    symbols: {
      added: difference(newIds, oldIds),
      removed: difference(oldIds, newIds),
      modified: modified.sort((a, b) => a.localeCompare(b)),
      moved: moved.sort((a, b) => a.localeCompare(b)),
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
