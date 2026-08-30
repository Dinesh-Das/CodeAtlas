import { buildRepository } from "../compiler/build.js";
import { loadCurrentAtlas } from "./v2-query.js";

export async function buildArchitectureDiff(
  startPath = process.cwd(),
  base = "HEAD",
  head = "HEAD",
) {
  await buildRepository(startPath, { gitBase: base, gitHead: head, snapshot: false });
  const atlas = await loadCurrentAtlas(startPath);
  return {
    base,
    head,
    changes: atlas.git_changes,
    changedSymbols: [...new Set(atlas.git_changes.flatMap((change) => change.symbol_ids))],
    impactedSymbols: [...new Set(atlas.git_changes.flatMap((change) =>
      change.impact_paths.map((item) => item.impacted),
    ))],
  };
}

export function formatArchitectureDiff(result: Awaited<ReturnType<typeof buildArchitectureDiff>>): string {
  return [
    `Architecture diff ${result.base}..${result.head}`,
    `Changed files: ${result.changes.length}`,
    `Changed symbols: ${result.changedSymbols.length}`,
    `Impacted symbols: ${result.impactedSymbols.length}`,
    ...result.changes.map((change) =>
      `  ${change.status.padEnd(8)} ${change.previous_file === null ? change.file : `${change.previous_file} -> ${change.file}`}`,
    ),
  ].join("\n");
}
