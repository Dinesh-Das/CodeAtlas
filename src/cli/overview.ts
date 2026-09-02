import { workspacePaths } from "../core/workspace.js";
import { openDatabase } from "../storage/database.js";
import { ensureFreshIndex } from "../mcp/freshness.js";
import {
  classifyArchitecturalScope,
  isPrimaryArchitectureScope,
} from "../analysis/scope.js";

export interface CliOverview {
  repository: string;
  root: string;
  files: number;
  nodes: number;
  relationships: number;
  communities: number;
  domains: number;
  features: number;
  apiRoutes: number;
  databaseModels: number;
  majorSystems: Array<{ kind: string; name: string; members: number | null }>;
  entrypoints: Array<{ file: string; fanOut: number }>;
  hotspots: Array<{ file: string; title: string; severity: string }>;
}

export async function getOverview(startPath = process.cwd()): Promise<CliOverview> {
  const context = await ensureFreshIndex(startPath);
  const database = openDatabase(workspacePaths(context.status.root).database, { readonly: true });
  try {
    const majorSystemRows = database
      .prepare(
        `SELECT kind, name,
                coalesce(
                  json_extract(metadata_json, '$.member_file_count'),
                  json_extract(metadata_json, '$.semantic_member_count')
                ) AS members,
                metadata_json AS metadataJson
         FROM nodes
         WHERE kind IN ('domain', 'feature', 'package')
         ORDER BY CASE kind WHEN 'domain' THEN 1 WHEN 'feature' THEN 2 ELSE 3 END,
                  coalesce(members, 0) DESC, name
         LIMIT 100`,
      )
      .all() as Array<{
        kind: string;
        name: string;
        members: number | null;
        metadataJson: string | null;
      }>;
    const majorSystems = majorSystemRows.filter((system) => {
      if (system.name === ".") return false;
      const metadata = system.metadataJson === null
        ? {}
        : JSON.parse(system.metadataJson) as { evidence?: { file?: string } };
      return isPrimaryArchitectureScope(
        classifyArchitecturalScope(metadata.evidence?.file ?? null),
      );
    }).slice(0, 12).map(({ kind, name, members }) => ({ kind, name, members }));
    const entrypointRows = database
      .prepare(
        `SELECT nodes.file_path AS file, coalesce(metrics.fan_out, 0) AS fanOut
         FROM nodes
         LEFT JOIN architecture_metrics metrics ON metrics.file_node_id = nodes.id
         WHERE nodes.kind = 'file'
           AND lower(nodes.name) IN (
             'app.js', 'app.ts', 'index.js', 'index.ts', 'main.js', 'main.py', 'main.ts',
             'server.js', 'server.ts'
           )
           AND length(nodes.file_path) - length(replace(nodes.file_path, '/', '')) <= 4
         ORDER BY fanOut DESC, nodes.file_path
         LIMIT 100`,
      )
      .all() as Array<{ file: string; fanOut: number }>;
    const entrypoints = entrypointRows
      .filter((entrypoint) => classifyArchitecturalScope(entrypoint.file) === "production")
      .slice(0, 8);
    const hotspotRows = database
      .prepare(
        `SELECT file_path AS file, title, severity
         FROM architecture_findings
         WHERE finding_type = 'change_hotspot'
         ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                  confidence DESC, file_path
         LIMIT 100`,
      )
      .all() as Array<{ file: string; title: string; severity: string }>;
    const hotspots = hotspotRows
      .filter((hotspot) => classifyArchitecturalScope(hotspot.file) === "production")
      .slice(0, 8);
    return {
      repository: context.status.repository,
      root: context.status.root,
      files: context.status.files,
      nodes: context.status.nodes,
      relationships: context.status.edges,
      communities: context.status.communities,
      domains: context.status.domains,
      features: context.status.features,
      apiRoutes: context.status.apiRoutes,
      databaseModels: context.status.databaseModels,
      majorSystems,
      entrypoints,
      hotspots,
    };
  } finally {
    database.close();
  }
}

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

export function formatOverview(overview: CliOverview): string {
  const systems = overview.majorSystems.length === 0
    ? ["  No domain or feature groups detected yet"]
    : overview.majorSystems.map((system) =>
        `  ${system.name}  ${system.kind}${system.members === null ? "" : ` · ${count(system.members, "member")}`}`,
      );
  const entrypoints = overview.entrypoints.length === 0
    ? ["  No conventional entrypoints detected"]
    : overview.entrypoints.map((entrypoint) =>
        `  ${entrypoint.file}${entrypoint.fanOut > 0 ? ` · fan-out ${entrypoint.fanOut}` : ""}`,
      );
  const hotspots = overview.hotspots.length === 0
    ? ["  No change hotspots crossed the configured threshold"]
    : overview.hotspots.map((hotspot) =>
        `  ${hotspot.file} · ${hotspot.severity} · ${hotspot.title}`,
      );
  return [
    overview.repository,
    "",
    [
      count(overview.files, "file"),
      count(overview.nodes, "node"),
      count(overview.relationships, "relationship"),
    ].join(" · "),
    [
      count(overview.communities, "architectural community", "architectural communities"),
      count(overview.domains, "domain"),
      count(overview.features, "feature"),
      count(overview.apiRoutes, "API route"),
      count(overview.databaseModels, "data model"),
    ].join(" · "),
    "",
    "Major systems",
    ...systems,
    "",
    "Start here",
    ...entrypoints,
    "",
    "Hotspots",
    ...hotspots,
    "",
    "Ask your coding agent",
    '  "Give me the repository architecture overview."',
    '  "How does authentication work? Show verified and inferred evidence."',
    '  "What is the blast radius if I change this symbol?"',
  ].join("\n");
}
