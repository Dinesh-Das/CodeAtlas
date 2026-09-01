import { writeTextAtomic } from "../core/workspace.js";
import type { Atlas } from "../ir/models.js";
import { isPrimaryArchitectureSymbol, symbolArchitecturalScope } from "../analysis/scope.js";

export function renderAtlasMarkdown(atlas: Atlas): string {
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const meaningfulKinds = new Set([
    "endpoint", "function", "method", "class", "interface", "module", "file", "database_model",
  ]);
  const highImpact = [...atlas.impact.scores]
    .filter((score) => {
      const symbol = symbolById.get(score.symbol_id);
      return symbol !== undefined && isPrimaryArchitectureSymbol(symbol) && meaningfulKinds.has(symbol.kind);
    })
    .sort((left, right) => right.score - left.score || left.symbol_id.localeCompare(right.symbol_id))
    .slice(0, 12);
  const primaryDomains = atlas.domains.map((domain) => {
    const members = domain.member_ids.map((id) => symbolById.get(id))
      .filter((symbol) => symbol !== undefined && isPrimaryArchitectureSymbol(symbol));
    return { domain, members };
  }).filter((item) => item.members.length > 0);
  const scopeCounts = new Map<string, number>();
  for (const symbol of atlas.symbols) {
    const scope = symbolArchitecturalScope(symbol);
    scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
  }
  const lines = [
    `# CodeAtlas: ${atlas.project.name}`,
    "",
    `Schema: ${atlas.schema_version} · Snapshot: ${atlas.snapshot.id}`,
    "",
    "## Architecture overview",
    "",
    `- ${atlas.statistics.files} files`,
    `- ${atlas.statistics.symbols} symbols`,
    `- ${atlas.statistics.relationships} relationships`,
    `- ${atlas.statistics.domains} domains`,
    `- ${atlas.statistics.entrypoints} entrypoints`,
    `- Scope: ${[...scopeCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([scope, count]) => `${scope}=${count}`).join(", ")}`,
    "",
    "## Domains",
    "",
    ...primaryDomains.flatMap(({ domain, members }) => [
      `### ${domain.name}`,
      "",
      `${new Set(members.map((symbol) => symbol?.file).filter(Boolean)).size} primary files, ${members.length} primary members, ${domain.entrypoint_ids.length} entrypoints.`,
      "",
    ]),
    "## Entrypoints",
    "",
    ...atlas.entrypoint_ids.map((id) => {
      const symbol = symbolById.get(id);
      return `- ${symbol?.name ?? id}${symbol?.file === null || symbol?.file === undefined ? "" : ` — ${symbol.file}:${symbol.location?.start_line ?? 1}`}`;
    }),
    "",
    "## High-impact components",
    "",
    ...highImpact.map((score) => {
      const symbol = symbolById.get(score.symbol_id);
      return `- ${symbol?.qualified_name ?? symbol?.name ?? score.symbol_id}: ${score.risk} (${score.score}/100) — ${score.reasons.join(", ") || "no known dependents"}`;
    }),
    "",
    "## Architecture rules",
    "",
    atlas.rules.length === 0
      ? "No architecture rules are configured."
      : `${atlas.rules.length} rules evaluated; ${atlas.rule_violations.length} violations found.`,
    "",
    "## Agent usage",
    "",
    "Use `codeatlas mcp` for compact graph queries with evidence. The canonical machine-readable IR is `.codeatlas/current/atlas.json`.",
    "",
  ];
  return lines.join("\n");
}

export async function exportAtlasMarkdown(atlas: Atlas, outputPath: string): Promise<void> {
  await writeTextAtomic(outputPath, renderAtlasMarkdown(atlas));
}
