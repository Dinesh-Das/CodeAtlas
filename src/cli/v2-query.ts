import { describeImpact } from "../analysis/impact.js";
import type { Atlas } from "../ir/models.js";
import { architectureService } from "../service/architecture-service.js";

export async function loadCurrentAtlas(startPath = process.cwd()): Promise<Atlas> {
  return (await architectureService.load(startPath)).atlas;
}

export function findSymbols(atlas: Atlas, query: string, limit = 50): Atlas["symbols"] {
  const needle = query.toLocaleLowerCase();
  return atlas.symbols.filter((symbol) =>
    [symbol.id, symbol.name, symbol.qualified_name, symbol.file, symbol.kind]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(needle)),
  ).slice(0, limit);
}

export function resolveSymbol(atlas: Atlas, target: string): Atlas["symbols"][number] {
  const exact = atlas.symbols.find((symbol) =>
    symbol.id === target || symbol.qualified_name === target,
  );
  if (exact !== undefined) return exact;
  const matches = findSymbols(atlas, target, 2);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`Symbol not found: ${target}`);
  throw new Error(`Symbol is ambiguous: ${target}. Use its exact ID or qualified name.`);
}

export function impactFor(atlas: Atlas, target: string, depth = 8, limit = 100) {
  const symbol = resolveSymbol(atlas, target);
  return { symbol, ...describeImpact(atlas, symbol.id, { depth, limit }) };
}
