import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

function incrementalResult(measurement) {
  return {
    durationMs: measurement.durationMs,
    peakRssBytes: Math.max(measurement.peakRssBytes, measurement.value.peakRssBytes),
    indexedFiles: measurement.value.changedFiles,
    addedFiles: measurement.value.addedFiles,
    modifiedFiles: measurement.value.modifiedFiles,
    deletedFiles: measurement.value.deletedFiles,
    renamedFiles: measurement.value.renamedFiles,
    invalidatedFiles: measurement.value.invalidatedFiles,
    fullRebuild: measurement.value.fullRebuild,
    invalidationTruncated: measurement.value.invalidationTruncated,
    invalidationTruncationReason: measurement.value.invalidationTruncationReason,
    semanticChanges: measurement.value.semanticChanges,
    work: measurement.value.work,
    phaseTimingsMs: measurement.value.timingsMs,
    phaseMetrics: measurement.value.phaseMetrics,
  };
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
    incremental.noChange = incrementalResult(noChange);
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
      incremental[changedFiles] = incrementalResult(result);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }

    const scenarios = {};
    const centralPath = path.join(fixture.root, "src", "module-0.ts");
    const centralBaseline = await readFile(centralPath, "utf8");
    const runScenario = async (name, mutate, restore = async () => {
      await writeFile(centralPath, centralBaseline, "utf8");
    }) => {
      await mutate();
      const measured = await timed(() => indexRepository(fixture.root));
      peakRss = Math.max(peakRss, await measured.finishMonitoring(), measured.value.peakRssBytes);
      scenarios[name] = incrementalResult(measured);
      await restore();
      await indexRepository(fixture.root);
    };

    await runScenario("comment-only", () =>
      appendFile(centralPath, "// deterministic comment-only scenario\n"));
    await runScenario("format-only", () =>
      writeFile(
        centralPath,
        centralBaseline.replace(
          "export function checkoutFeature0(): number { return 0; }",
          "export   function checkoutFeature0 ( ) : number {\n  return 0;\n}",
        ),
        "utf8",
      ));
    await runScenario("implementation-only", () =>
      writeFile(centralPath, centralBaseline.replace("return 0;", "return 1;"), "utf8"));
    await runScenario("local-reference-change", () =>
      writeFile(
        centralPath,
        centralBaseline.replace("return 0;", "const local = 1; return local;"),
        "utf8",
      ));
    await runScenario("export-change", () =>
      writeFile(centralPath, centralBaseline.replaceAll("checkoutFeature0", "renamedFeature0"), "utf8"));
    await runScenario("public-signature-change", () =>
      writeFile(
        centralPath,
        centralBaseline.replace("checkoutFeature0()", "checkoutFeature0(value = 0)"),
        "utf8",
      ));

    const leafPath = path.join(fixture.root, "src", "incremental-leaf.ts");
    await runScenario(
      "new-leaf-file",
      () => writeFile(leafPath, "export const incrementalLeaf = true;\n", "utf8"),
      async () => { await rm(leafPath, { force: true }); },
    );
    await writeFile(leafPath, "export const incrementalLeaf = true;\n", "utf8");
    await indexRepository(fixture.root);
    await runScenario(
      "delete-leaf-file",
      () => rm(leafPath, { force: true }),
      async () => {},
    );
    const renameSource = path.join(fixture.root, "src", "rename-leaf.ts");
    await writeFile(renameSource, "export const renameLeaf = true;\n", "utf8");
    await git(fixture.root, "add", "src/rename-leaf.ts");
    await git(fixture.root, "commit", "-m", "Add rename benchmark leaf", "--", "src/rename-leaf.ts");
    await indexRepository(fixture.root);
    await runScenario(
      "rename-file",
      () => git(fixture.root, "mv", "src/rename-leaf.ts", "src/renamed-leaf.ts"),
      () => git(fixture.root, "mv", "src/renamed-leaf.ts", "src/rename-leaf.ts"),
    );
    await runScenario("central-high-fan-out-export-change", () =>
      writeFile(
        centralPath,
        centralBaseline.replace("checkoutFeature0()", "checkoutFeature0(extra = 0)"),
        "utf8",
      ));

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
      incrementalScenarios: scenarios,
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
