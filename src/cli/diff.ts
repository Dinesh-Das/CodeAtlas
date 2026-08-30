import { buildAtlasAtGitHead } from "../git/ref-atlas.js";

export async function buildArchitectureDiff(
  startPath = process.cwd(),
  base = "HEAD",
  head = "HEAD",
) {
  const atlas = await buildAtlasAtGitHead(startPath, base, head, { snapshot: false });
  return {
    base,
    head,
    changes: atlas.git_changes,
    changedSymbols: [...new Set(atlas.git_changes.flatMap((change) => change.symbol_ids))],
    impactedSymbols: [...new Set(atlas.git_changes.flatMap((change) => change.impacted_symbol_ids))],
  };
}

export function formatArchitectureDiff(result: Awaited<ReturnType<typeof buildArchitectureDiff>>): string {
  return [
    `Architecture diff ${result.base}..${result.head}`,
    `Changed files: ${result.changes.length}`,
    `Changed symbols: ${result.changedSymbols.length}`,
    `Impacted symbols: ${result.impactedSymbols.length}`,
    ...result.changes.flatMap((change) => [
      `  ${change.status.padEnd(8)} ${change.previous_file === null ? change.file : `${change.previous_file} -> ${change.file}`}`,
      ...change.symbol_changes.map((symbol) =>
        `    ${symbol.status.padEnd(8)} ${symbol.kind} ${symbol.qualified_name ?? symbol.name}`,
      ),
      ...(change.impacted_symbol_ids.length === 0
        ? []
        : [`    IMPACTED ${change.impacted_symbol_ids.length} symbols · tests ${change.related_test_ids.length} · rules ${change.rule_violation_ids.length} · review ${change.review_finding_ids.length}`]),
    ]),
  ].join("\n");
}
