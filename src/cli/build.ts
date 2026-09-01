import { setTimeout as delay } from "node:timers/promises";
import { buildRepository, type BuildResult } from "../compiler/build.js";
import { getStatus } from "./status.js";
import type { IndexProgress } from "../core/telemetry.js";

export { buildRepository, type BuildResult };

export function formatBuildResult(result: BuildResult): string {
  const stats = result.statistics;
  return [
    "[OK] Repository detected",
    `[OK] ${result.parsedFiles} files parsed, ${result.reusedFiles} reused`,
    `[OK] ${stats.symbols} symbols and ${stats.relationships} relationships compiled`,
    `[OK] ${stats.domains} domains, ${stats.entrypoints} entrypoints, ${stats.flows} flows`,
    `[OK] ${stats.controlFlows} function control-flow graphs`,
    `[OK] ${stats.ruleViolations} architecture-rule violations`,
    result.snapshotCreated ? `[OK] Snapshot ${result.snapshotId} created` : null,
    "",
    "Generated:",
    `  ${result.htmlPath}`,
    `  ${result.markdownPath}`,
    `  ${result.mermaidPath}`,
    `  ${result.currentDirectory}`,
    result.bundlePath === null ? null : `  ${result.bundlePath}`,
    "",
    `Performance (ms): collect ${result.timingsMs.fileCollection.toFixed(0)}, parse ${result.timingsMs.parsing.toFixed(0)}, symbols ${result.timingsMs.symbolExtraction.toFixed(0)}, resolve ${result.timingsMs.relationshipResolution.toFixed(0)}, domains ${result.timingsMs.domainAnalysis.toFixed(0)}, flows ${result.timingsMs.flowGeneration.toFixed(0)}, CFG ${result.timingsMs.cfgGeneration.toFixed(0)}, impact ${result.timingsMs.impactIndexing.toFixed(0)}, Git ${result.timingsMs.gitAnalysis.toFixed(0)}, HTML ${result.timingsMs.htmlExport.toFixed(0)}, snapshot ${result.timingsMs.snapshotPersistence.toFixed(0)}`,
    `Total ${result.timingsMs.total.toFixed(0)} ms; parsed ${result.parsedFiles} files; reused ${result.reusedFiles} files`,
  ].filter((line): line is string => line !== null).join("\n");
}

export async function watchRepository(
  startPath: string,
  options: {
    intervalMs?: number;
    onProgress?: (progress: IndexProgress) => void;
    onBuild?: (result: BuildResult) => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const requestedInterval = options.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(requestedInterval) || requestedInterval < 250) {
    throw new Error("Watch interval must be an integer of at least 250 milliseconds.");
  }
  const intervalMs = requestedInterval;
  let status = await getStatus(startPath);
  while (!options.signal?.aborted) {
    if (!status.synchronized) {
      const result = await buildRepository(status.root, {
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
      options.onBuild?.(result);
    }
    await delay(intervalMs, undefined, { signal: options.signal }).catch((error: unknown) => {
      if (!options.signal?.aborted) throw error;
    });
    if (!options.signal?.aborted) status = await getStatus(status.root);
  }
}
