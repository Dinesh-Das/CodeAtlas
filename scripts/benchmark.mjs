import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { initializeRepository } from "../dist/cli/init.js";
import { indexRepository } from "../dist/cli/index-command.js";
import { searchPacket } from "../dist/mcp/graph-tools.js";
import { ensureFreshIndex } from "../dist/mcp/freshness.js";
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
  await execFile("git", gitArgs, { cwd: root, windowsHide: true });
}

function sourceFile(index, fileCount, linesPerFile) {
  const next = (index + 1) % fileCount;
  const filler = Array.from(
    { length: Math.max(0, linesPerFile - 3) },
    (_, line) => `// checkout domain fixture ${index}:${line}`,
  );
  return [
    `import { checkoutFeature${next} } from "./module-${next}.js";`,
    `export function checkoutFeature${index}(depth = 0): number { return depth > 0 ? checkoutFeature${next}(depth - 1) : ${index}; }`,
    ...filler,
    "",
  ].join("\n");
}

async function generateRepository(loc) {
  const root = await mkdtemp(path.join(os.tmpdir(), `codeatlas-benchmark-${loc}-`));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "CodeAtlas Benchmark");
  await git(root, "config", "user.email", "benchmark@example.invalid");
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
          sourceFile(index, fileCount, linesPerFile),
        );
      }),
    );
  }
  await git(root, "add", ".");
  await git(root, "commit", "-m", `generated ${loc} LOC benchmark fixture`);
  return { root, loc, fileCount };
}

async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, durationMs: Number((performance.now() - started).toFixed(2)) };
}

async function benchmarkSize(loc) {
  const fixture = await generateRepository(loc);
  let peakRss = process.memoryUsage().rss;
  try {
    const cold = await timed(() => initializeRepository(fixture.root));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const incremental = {};
    for (const changedFiles of [1, 5, 10]) {
      for (let index = 0; index < changedFiles; index += 1) {
        await appendFile(
          path.join(fixture.root, "src", `module-${index}.ts`),
          `// incremental benchmark ${changedFiles}\n`,
        );
      }
      const result = await timed(() => indexRepository(fixture.root));
      incremental[changedFiles] = {
        durationMs: result.durationMs,
        indexedFiles: result.value.changedFiles,
        invalidatedFiles: result.value.invalidatedFiles,
        phaseTimingsMs: result.value.timingsMs,
      };
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }

    const context = await ensureFreshIndex(fixture.root);
    const queryLatencies = [];
    const freshnessLatencies = [];
    for (let iteration = 0; iteration < 25; iteration += 1) {
      queryLatencies.push((await timed(async () => searchPacket(context, {
        query: "How does checkout work?",
        cursor: null,
        limit: 20,
      }))).durationMs);
      freshnessLatencies.push((await timed(() => ensureFreshIndex(fixture.root))).durationMs);
    }
    const database = await stat(workspacePaths(fixture.root).database);
    return {
      requestedLoc: loc,
      files: fixture.fileCount,
      coldIndexMs: cold.durationMs,
      coldPhaseTimingsMs: cold.value.timingsMs,
      incremental,
      warmSearchMs: { p50: percentile(queryLatencies, 0.5), p95: percentile(queryLatencies, 0.95) },
      freshnessAwareMs: {
        p50: percentile(freshnessLatencies, 0.5),
        p95: percentile(freshnessLatencies, 0.95),
      },
      peakObservedRssMb: Number((peakRss / 1024 / 1024).toFixed(2)),
      databaseMb: Number((database.size / 1024 / 1024).toFixed(2)),
    };
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5 });
  }
}

const results = [];
for (const size of sizes) results.push(await benchmarkSize(size));
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  profile,
  results,
}, null, 2));
