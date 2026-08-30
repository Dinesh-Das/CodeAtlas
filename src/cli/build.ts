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
    `  ${result.currentDirectory}`,
    result.bundlePath === null ? null : `  ${result.bundlePath}`,
    "",
    `Total ${result.timingsMs.total.toFixed(0)} ms (index ${result.timingsMs.indexing.toFixed(0)}, IR ${result.timingsMs.ir.toFixed(0)}, flows ${result.timingsMs.flows.toFixed(0)}, CFG ${result.timingsMs.controlFlow.toFixed(0)}, impact ${result.timingsMs.impact.toFixed(0)}, export ${result.timingsMs.export.toFixed(0)})`,
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
  const intervalMs = Math.max(250, options.intervalMs ?? 1_000);
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
