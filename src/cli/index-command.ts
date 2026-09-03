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
import {
  clearFastStatusCache,
  getFastIndexInputs,
  getFastStatus,
  type StatusResult,
} from "./status.js";

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
        gitAvailable: status.gitAvailable,
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
      semanticChanges: {
        content_only: 0,
        implementation_only: 0,
        outgoing_change: 0,
        public_contract_change: 0,
        module_resolution_change: 0,
        added: 0,
        deleted: 0,
        renamed: 0,
      },
      work: {
        filesRead: 0,
        filesParsed: 0,
        filesSemanticallyAnalyzed: 0,
        dependentFilesInvalidated: 0,
        symbolsRewritten: 0,
        referencesRewritten: 0,
        candidateCount: 0,
        resolvedEdgeCount: 0,
        sqliteMutations: 0,
        ftsMutations: 0,
        architectureFiles: 0,
      },
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
      // Indexing is an explicit synchronization request. Always reconcile content here instead
      // of trusting the short-lived watcher cache, whose event can arrive after an immediate edit.
      status = await getFastStatus(startPath, { forceReconcile: true });
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
    const fastInputs = getFastIndexInputs(status.root);
    const result = await runIndex({
      startPath: status.root,
      precomputedRepository: {
        root: status.root,
        id: sha256(status.root),
        name: status.repository,
        gitAvailable: status.gitAvailable,
        headCommit: status.headCommit,
        branch: status.branch,
      },
      full: false,
      ...(fastInputs === null
        ? {}
        : {
            precomputedWorktree: fastInputs.worktree,
            precomputedIgnoreRules: fastInputs.ignoreRules,
          }),
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
    `[OK] Indexed ${result.files} files`,
    `[OK] Updated ${result.changedFiles} files`,
    result.addedFiles > 0 ? `[OK] Added ${result.addedFiles} files` : null,
    result.modifiedFiles > 0 ? `[OK] Modified ${result.modifiedFiles} files` : null,
    result.renamedFiles > 0 ? `[OK] Preserved identity for ${result.renamedFiles} renamed files` : null,
    result.invalidatedFiles > 0
      ? `[OK] Recomputed ${result.invalidatedFiles} dependent files`
      : null,
    result.invalidationTruncated
      ? `[!] Invalidation reached ${result.invalidationTruncationReason}; a full reconciliation was performed`
      : null,
    result.deletedFiles > 0 ? `[OK] Removed ${result.deletedFiles} deleted files` : null,
    result.fullRebuild ? "[OK] Completed a required full graph rebuild" : null,
    result.apiRoutes > 0 ? `[OK] Detected ${result.apiRoutes} API routes` : null,
    result.databaseModels > 0
      ? `[OK] Detected ${result.databaseModels} database models`
      : null,
    result.features > 0 ? `[OK] Grouped ${result.features} features` : null,
    result.domains > 0 ? `[OK] Identified ${result.domains} domains` : null,
    result.communities > 0
      ? `[OK] Found ${result.communities} dependency communities`
      : null,
    result.findings > 0
      ? `[!] Recorded ${result.findings} architecture signals`
      : "[OK] No architecture signals crossed configured thresholds",
    `[OK] Graph contains ${result.symbols} symbols and ${result.edges} relationships`,
    `[OK] Semantic changes content=${result.semanticChanges.content_only}, implementation=${result.semanticChanges.implementation_only}, outgoing=${result.semanticChanges.outgoing_change}, public=${result.semanticChanges.public_contract_change}, config=${result.semanticChanges.module_resolution_change}`,
    `[OK] Work parsed=${result.work.filesParsed}, dependents=${result.work.dependentFilesInvalidated}, candidates=${result.work.candidateCount}, resolved=${result.work.resolvedEdgeCount}, sqlite=${result.work.sqliteMutations}, fts=${result.work.ftsMutations}`,
    `[OK] Generations structural=${result.generations.structural}, semantic=${result.generations.semantic}, search=${result.generations.search}, architecture=${result.generations.architecture}`,
    `[OK] Index timing ${result.timingsMs.total.toFixed(0)} ms (discover ${result.timingsMs.discovery.toFixed(0)}, fingerprint ${result.timingsMs.fingerprint.toFixed(0)}, parse ${result.timingsMs.parsing.toFixed(0)}, persist ${result.timingsMs.persistence.toFixed(0)}, architecture ${result.timingsMs.architecture.toFixed(0)})`,
    `[OK] Peak observed RSS ${(result.peakRssBytes / 1024 / 1024).toFixed(1)} MB`,
    result.parseErrors > 0 ? `[!] ${result.parseErrors} files contain parse errors` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
