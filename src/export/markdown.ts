import { writeTextAtomic } from "../core/workspace.js";
import type { Atlas } from "../ir/models.js";

export function renderAtlasMarkdown(atlas: Atlas): string {
  const highImpact = [...atlas.impact.scores]
    .sort((left, right) => right.score - left.score || left.symbol_id.localeCompare(right.symbol_id))
    .slice(0, 12);
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
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
    "",
    "## Domains",
    "",
    ...atlas.domains.flatMap((domain) => [
      `### ${domain.name}`,
      "",
      `${domain.file_ids.length} files, ${domain.member_ids.length} members, ${domain.entrypoint_ids.length} entrypoints.`,
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
