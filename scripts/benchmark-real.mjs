import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initializeRepository } from "../dist/cli/init.js";
import { architectureOverviewPacket } from "../dist/mcp/architecture.js";
import {
  dependenciesPacket,
  getNodePacket,
  impactPacket,
  searchPacket,
  tracePacket,
} from "../dist/mcp/graph-tools.js";
import { ensureFreshIndex } from "../dist/mcp/freshness.js";
import { clearFastStatusCache } from "../dist/cli/status.js";
import { workspacePaths } from "../dist/core/workspace.js";
import { openDatabase } from "../dist/storage/database.js";

const execFile = promisify(execFileCallback);
const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli/index.js");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const requestedRepository = args.get("--repository");
if (requestedRepository === undefined) {
  throw new Error("Usage: node scripts/benchmark-real.mjs --repository <local-git-repository> [--output <json-file>]");
}

async function git(root, ...gitArgs) {
  return (await execFile("git", gitArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  })).stdout;
}

async function indexRepositoryInFreshProcess(root) {
  const { stdout } = await execFile(
    process.execPath,
    [cliEntry, "index", root, "--json"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}

async function timedFreshIndex(root) {
  const started = performance.now();
  const value = await indexRepositoryInFreshProcess(root);
  return {
    value,
    durationMs: Number((performance.now() - started).toFixed(2)),
    // Node does not expose resourceUsage() for a completed child process.
    cpuMs: null,
    peakRssBytes: value.peakRssBytes,
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(2));
}

async function timed(operation, monitorRss = false) {
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  if (!monitorRss) {
    const value = await operation();
    const cpu = process.cpuUsage(cpuStarted);
    return {
      value,
      durationMs: Number((performance.now() - started).toFixed(2)),
      cpuMs: Number(((cpu.user + cpu.system) / 1_000).toFixed(2)),
      peakRssBytes: 0,
    };
  }
  const stopPath = path.join(os.tmpdir(), `codeatlas-real-rss-${randomUUID()}.stop`);
  const environment = {
    ...process.env,
    CODEATLAS_MONITOR_PID: String(process.pid),
    CODEATLAS_MONITOR_STOP: stopPath,
  };
  const monitor = process.platform === "win32"
    ? spawn("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$targetPid=[int]$env:CODEATLAS_MONITOR_PID; $stop=$env:CODEATLAS_MONITOR_STOP; $peak=0; while(-not (Test-Path -LiteralPath $stop)){ try { $rss=(Get-Process -Id $targetPid -ErrorAction Stop).WorkingSet64; if($rss -gt $peak){$peak=$rss} } catch { break }; Start-Sleep -Milliseconds 10 }; Write-Output $peak",
      ], { env: environment, windowsHide: true })
    : spawn("sh", ["-c", 'peak=0; while [ ! -f "$CODEATLAS_MONITOR_STOP" ]; do rss=$(ps -o rss= -p "$CODEATLAS_MONITOR_PID" 2>/dev/null | tr -d " "); if [ -n "$rss" ] && [ "$rss" -gt "$peak" ]; then peak=$rss; fi; sleep 0.01; done; echo $((peak * 1024))'], { env: environment });
  let output = "";
  monitor.stdout.setEncoding("utf8");
  monitor.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const stop = async () => {
    await writeFile(stopPath, "stop", "utf8");
    if (monitor.exitCode === null) await new Promise((resolve) => monitor.once("exit", resolve));
    await rm(stopPath, { force: true });
    return Number.parseInt(output.trim(), 10) || 0;
  };
  try {
    const value = await operation();
    const peakRssBytes = await stop();
    const cpu = process.cpuUsage(cpuStarted);
    return {
      value,
      durationMs: Number((performance.now() - started).toFixed(2)),
      cpuMs: Number(((cpu.user + cpu.system) / 1_000).toFixed(2)),
      peakRssBytes,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

function indexMeasurement(measurement) {
  return {
    wallMs: measurement.durationMs,
    cpuMs: measurement.cpuMs,
    peakRssBytes: Math.max(measurement.peakRssBytes, measurement.value.peakRssBytes),
    changedFiles: measurement.value.changedFiles,
    addedFiles: measurement.value.addedFiles,
    modifiedFiles: measurement.value.modifiedFiles,
    deletedFiles: measurement.value.deletedFiles,
    renamedFiles: measurement.value.renamedFiles,
    invalidatedFiles: measurement.value.invalidatedFiles,
    invalidationTruncated: measurement.value.invalidationTruncated,
    invalidationTruncationReason: measurement.value.invalidationTruncationReason,
    fullRebuild: measurement.value.fullRebuild,
    generations: measurement.value.generations,
    semanticChanges: measurement.value.semanticChanges,
    work: measurement.value.work,
    timingsMs: measurement.value.timingsMs,
    phaseMetrics: measurement.value.phaseMetrics,
  };
}

async function appendMarker(root, relativePath, marker) {
  await appendFile(path.join(root, ...relativePath.split("/")), `\n// ${marker}\n`, "utf8");
}

async function appendInternalImplementation(root, relativePath) {
  const typed = /\.[cm]?tsx?$/u.test(relativePath);
  const signature = typed
    ? "function codeatlasImplementationBenchmark(): number"
    : "function codeatlasImplementationBenchmark()";
  await appendFile(
    path.join(root, ...relativePath.split("/")),
    `\n${signature} { return 1; }\n`,
    "utf8",
  );
}

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const originalRoot = path.resolve(requestedRepository);
const originalCommit = (await git(originalRoot, "rev-parse", "HEAD")).trim();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codeatlas-real-benchmark-"));
const worktreeRoot = path.join(temporaryRoot, "repository");
const outputPath = path.resolve(
  args.get("--output") ??
    path.join(os.tmpdir(), "codeatlas-benchmarks", `real-${Date.now()}.json`),
);

let worktreeAdded = false;
try {
  await git(originalRoot, "worktree", "add", "--detach", worktreeRoot, originalCommit);
  worktreeAdded = true;
  const tracked = (await git(worktreeRoot, "ls-files", "-z"))
    .split("\0")
    .filter((entry) => entry !== "");
  const sources = tracked.filter((filePath) => sourceExtensions.has(path.posix.extname(filePath)));
  if (sources.length < 12) throw new Error("The real-repository benchmark requires at least 12 JS/TS source files.");

  let supportedLoc = 0;
  for (const filePath of sources) {
    try {
      supportedLoc += (await readFile(path.join(worktreeRoot, ...filePath.split("/")), "utf8"))
        .split(/\r?\n/u).length;
    } catch {
      // A disappearing/generated file is counted by the index diagnostics instead.
    }
  }

  const startupRssBytes = process.memoryUsage().rss;
  const cold = await timed(() => initializeRepository(worktreeRoot), true);
  const scenarios = { cold: indexMeasurement(cold) };

  const sourceSet = new Set(sources);
  const rankingDatabase = openDatabase(workspacePaths(worktreeRoot).database, { readonly: true });
  let lowImpactFiles;
  let targetNodeId;
  let targetFilePath;
  try {
    const target = rankingDatabase
      .prepare(
        `SELECT id, file_path AS filePath FROM nodes
         WHERE kind IN ('class', 'function', 'method', 'interface')
         ORDER BY id LIMIT 1`,
      )
      .get();
    targetNodeId = target?.id;
    targetFilePath = target?.filePath;
    const rankedPaths = rankingDatabase
      .prepare(
        `SELECT file_path AS filePath
         FROM architecture_metrics
         ORDER BY fan_in ASC, fan_out ASC, dependency_depth ASC, file_path`,
      )
      .all()
      .map((row) => row.filePath);
    const rankedSet = new Set(rankedPaths);
    lowImpactFiles = [
      ...rankedPaths.filter((filePath) => sourceSet.has(filePath)),
      ...sources.filter((filePath) => !rankedSet.has(filePath)),
    ].filter((filePath) => filePath !== targetFilePath);
  } finally {
    rankingDatabase.close();
  }
  if (lowImpactFiles.length < 12) {
    throw new Error("The real-repository benchmark could not select twelve low-impact source files.");
  }

  // Incremental indexing already reports its own peak RSS. Avoid spawning an
  // external sampler here: its startup and shutdown otherwise dominate the
  // sub-two-second scenarios that this harness is intended to measure.
  scenarios.noChange = indexMeasurement(await timedFreshIndex(worktreeRoot));

  const requestedCentralFile = "api/src/server.ts";
  const centralFile = sourceSet.has(requestedCentralFile)
    ? requestedCentralFile
    : lowImpactFiles[0];
  const centralAbsolutePath = path.join(worktreeRoot, ...centralFile.split("/"));
  const centralOriginal = await readFile(centralAbsolutePath, "utf8");
  await appendMarker(worktreeRoot, centralFile, "codeatlas incremental benchmark");
  scenarios.commentCentralFile = indexMeasurement(
    await timedFreshIndex(worktreeRoot),
  );
  await writeFile(centralAbsolutePath, centralOriginal, "utf8");
  scenarios.commentCentralFileRevert = indexMeasurement(
    await timedFreshIndex(worktreeRoot),
  );

  await appendInternalImplementation(worktreeRoot, lowImpactFiles[0]);
  scenarios.oneImplementationChange = indexMeasurement(
    await timedFreshIndex(worktreeRoot),
  );

  const exportFile = sources.find((filePath) => /\.[cm]?tsx?$/u.test(filePath)) ?? sources[1];
  await appendFile(
    path.join(worktreeRoot, ...exportFile.split("/")),
    "\nexport const codeatlasBenchmarkExport = true;\n",
    "utf8",
  );
  scenarios.exportedSymbolChange = indexMeasurement(
    await timedFreshIndex(worktreeRoot),
  );

  const sharedFile = sources.find((filePath) => /^(?:packages?|libs?)\//u.test(filePath)) ?? sources[2];
  await appendMarker(worktreeRoot, sharedFile, "CodeAtlas shared-package benchmark");
  scenarios.sharedPackageChange = indexMeasurement(
    await timedFreshIndex(worktreeRoot),
  );

  for (const count of [5, 10]) {
    for (const filePath of lowImpactFiles.slice(0, count)) {
      await appendMarker(worktreeRoot, filePath, `CodeAtlas ${count}-file benchmark`);
    }
    scenarios[`${count}FileChange`] = indexMeasurement(
      await timedFreshIndex(worktreeRoot),
    );
  }

  const renameSource = lowImpactFiles[10];
  const renameTarget = path.posix.join(
    path.posix.dirname(renameSource),
    `codeatlas-benchmark-renamed-${path.posix.basename(renameSource)}`,
  );
  await git(worktreeRoot, "mv", renameSource, renameTarget);
  scenarios.rename = indexMeasurement(await timedFreshIndex(worktreeRoot));

  await rm(path.join(worktreeRoot, ...lowImpactFiles[11].split("/")));
  scenarios.deletion = indexMeasurement(await timedFreshIndex(worktreeRoot));

  const context = await ensureFreshIndex(worktreeRoot);
  const database = openDatabase(workspacePaths(worktreeRoot).database, { readonly: true });
  let counts;
  let relationshipQuality;
  let importResolution;
  let databaseObjects;
  try {
    counts = database
      .prepare(
        `SELECT
           (SELECT count(*) FROM files) AS files,
           (SELECT count(*) FROM nodes) AS nodes,
           (SELECT count(*) FROM edges) AS edges,
           (SELECT count(*) FROM resolution_issues) AS resolutionIssues,
           (SELECT count(*) FROM nodes WHERE kind = 'api_route') AS apiRoutes,
           (SELECT count(*) FROM nodes WHERE kind = 'database_model') AS databaseModels,
           (SELECT count(*) FROM files
              WHERE parse_status IN ('parsed_with_errors', 'parse_error')) AS parserFailures`,
      )
      .get();
    relationshipQuality = database
      .prepare(
        `SELECT provenance_category AS provenance, count(*) AS count
         FROM edges GROUP BY provenance_category ORDER BY provenance_category`,
      )
      .all();
    importResolution = database
      .prepare(
        `SELECT coalesce(json_extract(metadata_json, '$.import_classification'), 'uncategorized') AS category,
                count(*) AS count
         FROM resolution_issues
         WHERE reference_kind = 'import'
         GROUP BY category ORDER BY category`,
      )
      .all();
    databaseObjects = database
      .prepare(
        `SELECT name, sum(pgsize) AS bytes
         FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12`,
      )
      .all();
  } finally {
    database.close();
  }
  if (typeof targetNodeId !== "string") throw new Error("No semantic target was indexed.");

  const queryDurations = {
    getNode: [],
    dependencies: [],
    search: [],
    trace: [],
    impact: [],
    overview: [],
    freshness: [],
  };
  for (let iteration = 0; iteration < 30; iteration += 1) {
    queryDurations.getNode.push((await timed(() => getNodePacket(context, { node_id: targetNodeId }))).durationMs);
    queryDurations.dependencies.push((await timed(() => dependenciesPacket(context, { target: targetNodeId, direction: "both", cursor: null, limit: 20 }))).durationMs);
    queryDurations.search.push((await timed(() => searchPacket(context, { query: "How does this system work?", cursor: null, limit: 20 }))).durationMs);
    queryDurations.trace.push((await timed(() => tracePacket(context, { start: targetNodeId, max_depth: 6, cursor: null, limit: 20 }))).durationMs);
    queryDurations.impact.push((await timed(() => impactPacket(context, { target: targetNodeId, cursor: null, limit: 20 }))).durationMs);
    queryDurations.overview.push((await timed(() => architectureOverviewPacket(context, { cursor: null, limit: 20 }))).durationMs);
    queryDurations.freshness.push((await timed(() => ensureFreshIndex(worktreeRoot))).durationMs);
  }
  const queryPercentiles = Object.fromEntries(
    Object.entries(queryDurations).map(([name, values]) => [
      name,
      { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) },
    ]),
  );

  const databaseStat = await stat(workspacePaths(worktreeRoot).database);
  const result = {
    generatedAt: new Date().toISOString(),
    sourceRepository: originalRoot,
    repositoryCommit: originalCommit,
    benchmarkWorktree: "temporary detached Git worktree (removed after completion)",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    supportedSourceFiles: sources.length,
    supportedLoc,
    startupRssBytes,
    finalRssBytes: process.memoryUsage().rss,
    counts,
    queryTargetNodeId: targetNodeId,
    relationshipQuality,
    importResolution,
    databaseObjects,
    databaseBytes: databaseStat.size,
    scenarios,
    queriesMs: queryPercentiles,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, ...result }, null, 2));
} finally {
  clearFastStatusCache(worktreeRoot);
  if (worktreeAdded) {
    await git(originalRoot, "worktree", "remove", "--force", worktreeRoot).catch(() => undefined);
    await git(originalRoot, "worktree", "prune").catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
}
