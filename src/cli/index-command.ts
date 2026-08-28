import { performance } from "node:perf_hooks";
import { workspaceExists } from "../core/workspace.js";
import { CodeAtlasError } from "../core/errors.js";
import { sha256 } from "../core/hashing.js";
import { workspacePaths } from "../core/workspace.js";
import { IndexTelemetry } from "../core/telemetry.js";
import type { IndexProgress } from "../core/telemetry.js";
import { detectRepository } from "../git/repository.js";
import { runIndex, type IndexResult } from "../indexer/indexer.js";
import { openDatabase } from "../storage/database.js";
import { clearFastStatusCache, getFastStatus, type StatusResult } from "./status.js";

function noChangeResult(
  status: StatusResult,
  startedAt: number,
  freshnessMs: number,
): IndexResult {
  const telemetry = new IndexTelemetry();
  telemetry.record("git_status_freshness", freshnessMs, { itemsProcessed: 0 });
  telemetry.start("finalization");
  const database = openDatabase(workspacePaths(status.root).database, { readonly: true });
  try {
    const languages = Object.fromEntries(
      (
        database
          .prepare(
            `SELECT language, count(*) AS count FROM files
             WHERE language IS NOT NULL GROUP BY language ORDER BY language`,
          )
          .all() as Array<{ language: string; count: number }>
      ).map((row) => [row.language, row.count]),
    );
    const frameworks = (
      database
        .prepare(
          `SELECT DISTINCT json_extract(metadata_json, '$.framework') AS framework
           FROM nodes
           WHERE kind IN ('api_route', 'database_model')
             AND json_extract(metadata_json, '$.framework') IS NOT NULL
           ORDER BY framework`,
        )
        .all() as Array<{ framework: string }>
    ).map((row) => row.framework);
    const parseErrors = database
      .prepare(
        `SELECT count(*) FROM files
         WHERE parse_status IN ('parsed_with_errors', 'parse_error')`,
      )
      .pluck()
      .get() as number;
    telemetry.end("finalization", { itemsProcessed: status.files });
    const phaseMetrics = telemetry.finish();
    return {
      repository: {
        root: status.root,
        id: sha256(status.root),
        name: status.repository,
        headCommit: status.headCommit,
        branch: status.branch,
      },
      fingerprint: status.currentFingerprint,
      files: status.files,
      changedFiles: 0,
      addedFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      renamedFiles: 0,
      invalidatedFiles: 0,
      invalidationTruncated: false,
      invalidationTruncationReason: null,
      fullRebuild: false,
      dirtyWorkingTree: status.dirty,
      nodes: status.nodes,
      edges: status.edges,
      symbols: status.symbols,
      parseErrors,
      apiRoutes: status.apiRoutes,
      databaseModels: status.databaseModels,
      features: status.features,
      domains: status.domains,
      communities: status.communities,
      cycles: status.cycles,
      hotspots: status.hotspots,
      findings: status.findings,
      languages,
      frameworks,
      indexedAt: status.lastIndexedAt ?? new Date().toISOString(),
      generations: status.generations,
      phaseMetrics,
      peakRssBytes: Math.max(...phaseMetrics.map((metric) => metric.peakRssBytes)),
      timingsMs: {
        discovery: 0,
        fingerprint: 0,
        parsing: 0,
        persistence: 0,
        architecture: 0,
        total: Number((performance.now() - startedAt).toFixed(2)),
      },
    };
  } finally {
    database.close();
    telemetry.finish();
  }
}

export async function indexRepository(
  startPath = process.cwd(),
  full = false,
  options: { onProgress?: (progress: IndexProgress) => void } = {},
): Promise<IndexResult> {
  const startedAt = performance.now();
  if (!full) {
    const freshnessStartedAt = performance.now();
    let status: StatusResult;
    try {
      status = await getFastStatus(startPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/(?:database|sqlite)/iu.test(message)) throw error;
      return runIndex({
        startPath,
        full: false,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
    }
    const freshnessMs = performance.now() - freshnessStartedAt;
    if (status.synchronized) return noChangeResult(status, startedAt, freshnessMs);
    const result = await runIndex({
      startPath: status.root,
      full: false,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    clearFastStatusCache(status.root);
    return result;
  }
  const repository = await detectRepository(startPath);
  if (!(await workspaceExists(repository.root))) {
    throw new CodeAtlasError("Error: CodeAtlas is not initialized. Run `codeatlas init` first.");
  }
  const result = await runIndex({
    startPath: repository.root,
    full,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  clearFastStatusCache(repository.root);
  return result;
}

export function formatIndexResult(result: IndexResult): string {
  return [
    `✓ Indexed ${result.files} files`,
    `✓ Updated ${result.changedFiles} files`,
    result.addedFiles > 0 ? `✓ Added ${result.addedFiles} files` : null,
    result.modifiedFiles > 0 ? `✓ Modified ${result.modifiedFiles} files` : null,
    result.renamedFiles > 0 ? `✓ Preserved identity for ${result.renamedFiles} renamed files` : null,
    result.invalidatedFiles > 0
      ? `✓ Recomputed ${result.invalidatedFiles} dependent files`
      : null,
    result.invalidationTruncated
      ? `! Invalidation reached ${result.invalidationTruncationReason}; a full reconciliation was performed`
      : null,
    result.deletedFiles > 0 ? `✓ Removed ${result.deletedFiles} deleted files` : null,
    result.fullRebuild ? "✓ Completed a required full graph rebuild" : null,
    result.apiRoutes > 0 ? `✓ Detected ${result.apiRoutes} API routes` : null,
    result.databaseModels > 0
      ? `✓ Detected ${result.databaseModels} database models`
      : null,
    result.features > 0 ? `✓ Grouped ${result.features} features` : null,
    result.domains > 0 ? `✓ Identified ${result.domains} domains` : null,
    result.communities > 0
      ? `✓ Found ${result.communities} dependency communities`
      : null,
    result.findings > 0
      ? `! Recorded ${result.findings} architecture signals`
      : "✓ No architecture signals crossed configured thresholds",
    `✓ Graph contains ${result.symbols} symbols and ${result.edges} relationships`,
    `✓ Generations structural=${result.generations.structural}, semantic=${result.generations.semantic}, search=${result.generations.search}, architecture=${result.generations.architecture}`,
    `✓ Index timing ${result.timingsMs.total.toFixed(0)} ms (discover ${result.timingsMs.discovery.toFixed(0)}, fingerprint ${result.timingsMs.fingerprint.toFixed(0)}, parse ${result.timingsMs.parsing.toFixed(0)}, persist ${result.timingsMs.persistence.toFixed(0)}, architecture ${result.timingsMs.architecture.toFixed(0)})`,
    `✓ Peak observed RSS ${(result.peakRssBytes / 1024 / 1024).toFixed(1)} MB`,
    result.parseErrors > 0 ? `! ${result.parseErrors} files contain parse errors` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
