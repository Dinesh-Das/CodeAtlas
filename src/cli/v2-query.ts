import { describeImpact } from "../analysis/impact.js";
import type { Atlas } from "../ir/models.js";
import { architectureService } from "../service/architecture-service.js";

export async function loadCurrentAtlas(startPath = process.cwd()): Promise<Atlas> {
  return (await architectureService.load(startPath)).atlas;
}

export function findSymbols(atlas: Atlas, query: string, limit = 50): Atlas["symbols"] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Search limit must be an integer between 1 and 10000.");
  }
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
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 30) {
    throw new Error("Impact depth must be an integer between 1 and 30.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) {
    throw new Error("Impact limit must be an integer between 1 and 2000.");
  }
  const symbol = resolveSymbol(atlas, target);
  return { symbol, ...describeImpact(atlas, symbol.id, { depth, limit }) };
}
