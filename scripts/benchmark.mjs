import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { initializeRepository } from "../dist/cli/init.js";
import { indexRepository } from "../dist/cli/index-command.js";
import { searchPacket } from "../dist/mcp/graph-tools.js";
import { ensureFreshIndex } from "../dist/mcp/freshness.js";
import { clearFastStatusCache } from "../dist/cli/status.js";
import { workspacePaths } from "../dist/core/workspace.js";

const execFile = promisify(execFileCallback);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const profile = args.get("--profile") ?? "smoke";
const explicitLoc = Number(args.get("--loc"));
const sizes = Number.isFinite(explicitLoc) && explicitLoc > 0
  ? [explicitLoc]
  : profile === "full"
    ? [10_000, 100_000, 500_000, 1_000_000]
    : [10_000];

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(2));
}

async function git(root, ...gitArgs) {
  await execFile("git", gitArgs, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function sourceFile(index, linesPerFile) {
  const dependency = index % 100 === 0 ? null : Math.floor(index / 100) * 100;
  const filler = Array.from(
    { length: Math.max(0, linesPerFile - 3) },
    (_, line) => `// checkout domain fixture ${index}:${line}`,
  );
  const implementation = dependency === null
    ? [`export function checkoutFeature${index}(): number { return ${index}; }`]
    : [
        `import { checkoutFeature${dependency} } from "./module-${dependency}.js";`,
        `export function checkoutFeature${index}(): number { return checkoutFeature${dependency}() + ${index}; }`,
      ];
  return [
    ...implementation,
    ...filler,
    "",
  ].join("\n");
}

async function generateRepository(loc) {
  const root = await mkdtemp(path.join(os.tmpdir(), `codeatlas-benchmark-${loc}-`));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "CodeAtlas Benchmark");
  await git(root, "config", "user.email", "benchmark@example.invalid");
  await git(root, "config", "core.autocrlf", "false");
  const linesPerFile = 100;
  const fileCount = Math.max(10, Math.ceil(loc / linesPerFile));
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    }),
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  for (let start = 0; start < fileCount; start += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, fileCount - start) }, (_, offset) => {
        const index = start + offset;
        return writeFile(
          path.join(root, "src", `module-${index}.ts`),
          sourceFile(index, linesPerFile),
        );
      }),
    );
  }
  await git(root, "add", ".");
  await git(root, "commit", "-m", `generated ${loc} LOC benchmark fixture`);
  return { root, loc, fileCount };
}

function editTargets(fileCount, changedFiles) {
  const clusterRoots = Array.from(
    { length: Math.ceil(fileCount / 100) },
    (_, index) => index * 100,
  );
  const remaining = Array.from({ length: fileCount }, (_, index) => index)
    .filter((index) => index % 100 !== 0);
  return [...clusterRoots, ...remaining].slice(0, changedFiles);
}

async function timed(operation) {
  const started = performance.now();
  const stopPath = path.join(os.tmpdir(), `codeatlas-rss-${randomUUID()}.stop`);
  const environment = {
    ...process.env,
    CODEATLAS_MONITOR_PID: String(process.pid),
    CODEATLAS_MONITOR_STOP: stopPath,
  };
  const monitor = process.platform === "win32"
    ? spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$targetPid=[int]$env:CODEATLAS_MONITOR_PID; $stop=$env:CODEATLAS_MONITOR_STOP; $peak=0; while(-not (Test-Path -LiteralPath $stop)){ try { $rss=(Get-Process -Id $targetPid -ErrorAction Stop).WorkingSet64; if($rss -gt $peak){$peak=$rss} } catch { break }; Start-Sleep -Milliseconds 10 }; Write-Output $peak",
        ],
        { env: environment, windowsHide: true },
      )
    : spawn(
        "sh",
        [
          "-c",
          'peak=0; while [ ! -f "$CODEATLAS_MONITOR_STOP" ]; do rss=$(ps -o rss= -p "$CODEATLAS_MONITOR_PID" 2>/dev/null | tr -d " "); if [ -n "$rss" ] && [ "$rss" -gt "$peak" ]; then peak=$rss; fi; sleep 0.01; done; echo $((peak * 1024))',
        ],
        { env: environment },
      );
  let monitorOutput = "";
  monitor.stdout.setEncoding("utf8");
  monitor.stdout.on("data", (chunk) => {
    monitorOutput += chunk;
  });
  const stopMonitoring = async () => {
    await writeFile(stopPath, "stop", "utf8");
    if (monitor.exitCode === null) {
      await new Promise((resolve) => monitor.once("exit", resolve));
    }
    await rm(stopPath, { force: true });
    return Number.parseInt(monitorOutput.trim(), 10) || 0;
  };
  try {
    const value = await operation();
    return {
      value,
      durationMs: Number((performance.now() - started).toFixed(2)),
      get peakRssBytes() {
        return Number.parseInt(monitorOutput.trim(), 10) || 0;
      },
      async finishMonitoring() {
        return stopMonitoring();
      },
    };
  } catch (error) {
    await stopMonitoring();
    throw error;
  }
}

async function timedLight(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, durationMs: Number((performance.now() - started).toFixed(2)) };
}

async function benchmarkSize(loc) {
  const fixture = await generateRepository(loc);
  const startupRss = process.memoryUsage().rss;
  let peakRss = startupRss;
  try {
    const cold = await timed(() => initializeRepository(fixture.root));
    const coldExternalPeak = await cold.finishMonitoring();
    peakRss = Math.max(
      peakRss,
      coldExternalPeak,
      cold.value.peakRssBytes,
      process.memoryUsage().rss,
    );
    const incremental = {};
    const noChange = await timed(() => indexRepository(fixture.root));
    peakRss = Math.max(
      peakRss,
      await noChange.finishMonitoring(),
      noChange.value.peakRssBytes,
    );
    incremental.noChange = {
      durationMs: noChange.durationMs,
      peakRssBytes: Math.max(noChange.peakRssBytes, noChange.value.peakRssBytes),
      indexedFiles: noChange.value.changedFiles,
      fullRebuild: noChange.value.fullRebuild,
      invalidationTruncated: noChange.value.invalidationTruncated,
      phaseTimingsMs: noChange.value.timingsMs,
      phaseMetrics: noChange.value.phaseMetrics,
    };
    for (const changedFiles of [1, 5, 10]) {
      for (const index of editTargets(fixture.fileCount, changedFiles)) {
        await appendFile(
          path.join(fixture.root, "src", `module-${index}.ts`),
          `// incremental benchmark ${changedFiles}\n`,
        );
      }
      const result = await timed(() => indexRepository(fixture.root));
      peakRss = Math.max(
        peakRss,
        await result.finishMonitoring(),
        result.value.peakRssBytes,
      );
      incremental[changedFiles] = {
        durationMs: result.durationMs,
        peakRssBytes: Math.max(result.peakRssBytes, result.value.peakRssBytes),
        indexedFiles: result.value.changedFiles,
        addedFiles: result.value.addedFiles,
        modifiedFiles: result.value.modifiedFiles,
        deletedFiles: result.value.deletedFiles,
        invalidatedFiles: result.value.invalidatedFiles,
        fullRebuild: result.value.fullRebuild,
        invalidationTruncated: result.value.invalidationTruncated,
        invalidationTruncationReason: result.value.invalidationTruncationReason,
        phaseTimingsMs: result.value.timingsMs,
        phaseMetrics: result.value.phaseMetrics,
      };
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }

    const context = await ensureFreshIndex(fixture.root);
    const queryLatencies = [];
    const freshnessLatencies = [];
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const query = await timedLight(async () => searchPacket(context, {
        query: "How does checkout work?",
        cursor: null,
        limit: 20,
      }));
      queryLatencies.push(query.durationMs);
      const freshness = await timedLight(() => ensureFreshIndex(fixture.root));
      freshnessLatencies.push(freshness.durationMs);
    }
    const database = await stat(workspacePaths(fixture.root).database);
    return {
      requestedLoc: loc,
      files: fixture.fileCount,
      coldIndexMs: cold.durationMs,
      coldPeakRssBytes: Math.max(coldExternalPeak, cold.value.peakRssBytes),
      coldPhaseTimingsMs: cold.value.timingsMs,
      coldPhaseMetrics: cold.value.phaseMetrics,
      incremental,
      warmSearchMs: {
        p50: percentile(queryLatencies, 0.5),
        p95: percentile(queryLatencies, 0.95),
        p99: percentile(queryLatencies, 0.99),
      },
      freshnessAwareMs: {
        p50: percentile(freshnessLatencies, 0.5),
        p95: percentile(freshnessLatencies, 0.95),
        p99: percentile(freshnessLatencies, 0.99),
      },
      startupRssMb: Number((startupRss / 1024 / 1024).toFixed(2)),
      postQueryRssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)),
      peakObservedRssMb: Number((peakRss / 1024 / 1024).toFixed(2)),
      databaseMb: Number((database.size / 1024 / 1024).toFixed(2)),
    };
  } finally {
    clearFastStatusCache(fixture.root);
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5 });
  }
}

const results = [];
for (const size of sizes) results.push(await benchmarkSize(size));
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  profile,
  results,
};
const outputPath = args.get("--output");
if (outputPath !== undefined) {
  const resolvedOutput = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(outputPath === undefined ? report : { outputPath: path.resolve(outputPath), ...report }, null, 2));
