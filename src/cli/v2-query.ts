import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeImpact } from "../analysis/impact.js";
import { workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import type { Atlas } from "../ir/models.js";
import { assertValidAtlas } from "../ir/validation.js";

export async function loadCurrentAtlas(startPath = process.cwd()): Promise<Atlas> {
  const repository = await detectRepository(startPath);
  const filePath = path.join(workspacePaths(repository.root).current, "atlas.json");
  try {
    const atlas = JSON.parse(await readFile(filePath, "utf8")) as Atlas;
    assertValidAtlas(atlas);
    return atlas;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("CodeAtlas IR does not exist. Run `codeatlas build .` first.");
    }
    throw error;
  }
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
  return { symbol, paths: analyzeImpact(atlas, symbol.id, { depth, limit }) };
}
