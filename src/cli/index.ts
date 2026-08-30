#!/usr/bin/env node
import { Command } from "commander";
import { CodeAtlasError } from "../core/errors.js";
import { CODEATLAS_VERSION } from "../version.js";
import { createIndexProgressReporter } from "./progress.js";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("codeatlas")
    .description("Build a local structural knowledge graph for a Git repository.")
    .version(CODEATLAS_VERSION);

  program
    .command("build")
    .description("Compile a repository into the canonical IR and portable architecture artifacts.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--full", "Rebuild the complete structural index", false)
    .option("--no-snapshot", "Do not persist an architecture snapshot")
    .option("--bundle", "Also generate a directory artifact with sharded data files", false)
    .option("--single-file", "Generate the self-contained HTML artifact (default)", true)
    .option("--json", "Print machine-readable JSON", false)
    .action(async (
      targetPath: string,
      options: { full: boolean; snapshot: boolean; bundle: boolean; singleFile: boolean; json: boolean },
    ) => {
      const { buildRepository, formatBuildResult } = await import("./build.js");
      const result = await buildRepository(targetPath, {
        full: options.full,
        snapshot: options.snapshot,
        bundle: options.bundle,
        ...(options.json ? {} : { onProgress: createIndexProgressReporter() }),
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatBuildResult(result));
    });

  program
    .command("update")
    .description("Incrementally update the canonical IR and generated architecture artifacts.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--json", "Print machine-readable JSON", false)
    .action(async (targetPath: string, options: { json: boolean }) => {
      const { buildRepository, formatBuildResult } = await import("./build.js");
      const result = await buildRepository(targetPath, {
        ...(options.json ? {} : { onProgress: createIndexProgressReporter() }),
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatBuildResult(result));
    });

  program
    .command("watch")
    .description("Watch for repository changes and incrementally regenerate artifacts.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--interval <milliseconds>", "Polling interval", "1000")
    .action(async (targetPath: string, options: { interval: string }) => {
      const { formatBuildResult, watchRepository } = await import("./build.js");
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.stderr.write("CodeAtlas is watching for changes. Press Ctrl+C to stop.\n");
      await watchRepository(targetPath, {
        intervalMs: Number(options.interval),
        signal: controller.signal,
        onBuild: (result) => console.log(formatBuildResult(result)),
      });
    });

  program
    .command("ask")
    .description("Answer an architecture question from graph paths and validated source evidence.")
    .argument("<question>", "Architecture or execution question")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--json", "Print structured claims and evidence", false)
    .action(async (question: string, targetPath: string, options: { json: boolean }) => {
      const { askRepository, formatAnswer } = await import("./ask.js");
      const result = await askRepository(question, targetPath);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatAnswer(result));
    });

  program
    .command("search")
    .description("Search the complete canonical architecture graph.")
    .argument("<query>", "Symbol name, qualified name, path, kind, or ID")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--limit <number>", "Maximum results", "50")
    .action(async (query: string, targetPath: string, options: { limit: string }) => {
      const { findSymbols, loadCurrentAtlas } = await import("./v2-query.js");
      console.log(JSON.stringify(findSymbols(await loadCurrentAtlas(targetPath), query, Number(options.limit)), null, 2));
    });

  program
    .command("symbol")
    .description("Show one symbol from the canonical architecture graph.")
    .argument("<id>", "Exact ID, qualified name, or unique search term")
    .argument("[path]", "A path inside the repository", process.cwd())
    .action(async (id: string, targetPath: string) => {
      const { loadCurrentAtlas, resolveSymbol } = await import("./v2-query.js");
      console.log(JSON.stringify(resolveSymbol(await loadCurrentAtlas(targetPath), id), null, 2));
    });

  program
    .command("impact")
    .description("Calculate evidence-linked reverse dependency paths for a symbol.")
    .argument("<symbol>", "Exact ID, qualified name, or unique search term")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--depth <number>", "Maximum traversal depth", "8")
    .option("--limit <number>", "Maximum paths", "100")
    .action(async (symbol: string, targetPath: string, options: { depth: string; limit: string }) => {
      const { impactFor, loadCurrentAtlas } = await import("./v2-query.js");
      console.log(JSON.stringify(impactFor(await loadCurrentAtlas(targetPath), symbol, Number(options.depth), Number(options.limit)), null, 2));
    });

  program
    .command("diff")
    .description("Map a Git base/head diff to symbols and architectural impact.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--base <ref>", "Base Git ref", "HEAD")
    .option("--head <ref>", "Head Git ref", "HEAD")
    .option("--json", "Print machine-readable JSON", false)
    .action(async (targetPath: string, options: { base: string; head: string; json: boolean }) => {
      const { buildArchitectureDiff, formatArchitectureDiff } = await import("./diff.js");
      const result = await buildArchitectureDiff(targetPath, options.base, options.head);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatArchitectureDiff(result));
    });

  program
    .command("check")
    .description("Evaluate architecture rules and fail for error-severity violations.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--json", "Print machine-readable JSON", false)
    .action(async (targetPath: string, options: { json: boolean }) => {
      const { checkRepository, formatCheckResult } = await import("./check.js");
      const result = await checkRepository(targetPath);
      console.log(options.json ? JSON.stringify(result.atlas.rule_violations, null, 2) : formatCheckResult(result));
      if (result.blocking > 0) process.exitCode = 1;
    });

  program
    .command("review")
    .description("Review a Git diff using architecture impact, rules, tests, and evidence.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--base <ref>", "Base Git ref", "HEAD")
    .option("--head <ref>", "Head Git ref", "HEAD")
    .option("--json", "Print machine-readable JSON", false)
    .action(async (targetPath: string, options: { base: string; head: string; json: boolean }) => {
      const { formatReviewResult, reviewRepository } = await import("./review.js");
      const result = await reviewRepository(targetPath, options.base, options.head);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatReviewResult(result));
    });

  const snapshot = program.command("snapshot").description("Manage persistent architecture snapshots.");
  snapshot.command("list")
    .argument("[path]", "A path inside the repository", process.cwd())
    .action(async (targetPath: string) => {
      const { snapshotList } = await import("./snapshot.js");
      console.log((await snapshotList(targetPath)).join("\n"));
    });
  snapshot.command("show")
    .argument("<id>", "Snapshot ID")
    .argument("[path]", "A path inside the repository", process.cwd())
    .action(async (id: string, targetPath: string) => {
      const { snapshotShow } = await import("./snapshot.js");
      console.log(JSON.stringify(await snapshotShow(id, targetPath), null, 2));
    });
  snapshot.command("diff")
    .argument("<old>", "Older snapshot ID")
    .argument("<new>", "Newer snapshot ID")
    .argument("[path]", "A path inside the repository", process.cwd())
    .action(async (oldId: string, newId: string, targetPath: string) => {
      const { snapshotDiff } = await import("./snapshot.js");
      console.log(JSON.stringify(await snapshotDiff(oldId, newId, targetPath), null, 2));
    });

  program
    .command("init")
    .description("Initialize CodeAtlas in the current Git repository.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--shared-ignore", "Add .codeatlas/ to the repository .gitignore", false)
    .action(async (targetPath: string, options: { sharedIgnore: boolean }) => {
      const { formatInitResult, initializeRepository } = await import("./init.js");
      process.stderr.write("CodeAtlas\n\nBuilding codebase map...\n\n");
      console.log(formatInitResult(await initializeRepository(targetPath, {
        ...options,
        onProgress: createIndexProgressReporter(),
      })));
    });

  program
    .command("index")
    .description("Synchronize the local CodeAtlas index.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--full", "Rebuild the complete index", false)
    .option("--quiet", "Suppress progress and summary output", false)
    .option("--json", "Print machine-readable JSON without terminal progress", false)
    .action(async (
      targetPath: string,
      options: { full: boolean; quiet: boolean; json: boolean },
    ) => {
      const { formatIndexResult, indexRepository } = await import("./index-command.js");
      const onProgress = options.quiet || options.json
        ? undefined
        : createIndexProgressReporter();
      const result = await indexRepository(
        targetPath,
        options.full,
        onProgress === undefined ? {} : { onProgress },
      );
      if (options.quiet) return;
      console.log(options.json ? JSON.stringify(result, null, 2) : formatIndexResult(result));
    });

  program
    .command("overview")
    .description("Print a useful architecture summary without requiring an MCP client.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--json", "Print machine-readable JSON", false)
    .action(async (targetPath: string, options: { json: boolean }) => {
      const { formatOverview, getOverview } = await import("./overview.js");
      const result = await getOverview(targetPath);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatOverview(result));
    });

  program
    .command("status")
    .description("Show repository and index synchronization status.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--json", "Print machine-readable JSON", false)
    .action(async (targetPath: string, options: { json: boolean }) => {
      const { formatStatus, getStatus } = await import("./status.js");
      const result = await getStatus(targetPath);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatStatus(result));
    });

  program
    .command("setup")
    .description("Configure supported coding agents to launch the CodeAtlas MCP server.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--target <clients>", "Comma-separated: codex, claude, cursor, antigravity")
    .option("--all", "Configure all supported clients", false)
    .option("--dry-run", "Show configuration destinations without changing them", false)
    .action(async (
      targetPath: string,
      options: { target?: string; all: boolean; dryRun: boolean },
    ) => {
      const {
        SETUP_TARGETS,
        formatSetupResult,
        parseSetupTargets,
        setupRepository,
      } = await import("./setup.js");
      if (options.all && options.target !== undefined) {
        throw new CodeAtlasError("Error: use either --all or --target, not both.");
      }
      const targets = options.all
        ? SETUP_TARGETS
        : options.target === undefined
          ? undefined
          : parseSetupTargets(options.target);
      const result = await setupRepository(targetPath, {
        ...(targets === undefined ? {} : { targets }),
        dryRun: options.dryRun,
        continueOnError: options.all,
      });
      console.log(formatSetupResult(result));
    });

  program
    .command("doctor")
    .description("Validate Git, configuration, storage, and runtime prerequisites.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .action(async (targetPath: string) => {
      const { formatDoctor, runDoctor } = await import("./doctor.js");
      const checks = await runDoctor(targetPath);
      console.log(formatDoctor(checks));
      if (checks.some((check) => !check.ok && check.severity !== "warning")) {
        process.exitCode = 1;
      }
    });

  program
    .command("mcp")
    .description("Start the CodeAtlas MCP server over stdio.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .action(async (targetPath: string) => {
      const { startMcpServer } = await import("./mcp.js");
      return startMcpServer(targetPath);
    });

  program
    .command("clean")
    .description("Delete the local CodeAtlas index safely.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--force", "Skip the confirmation prompt", false)
    .action(async (targetPath: string, options: { force: boolean }) => {
      const { cleanRepository } = await import("./clean.js");
      const removed = await cleanRepository(targetPath, options.force);
      console.log(removed ? "[OK] Removed .codeatlas/" : "CodeAtlas workspace was not removed.");
    });

  return program;
}

async function main(): Promise<void> {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = error instanceof CodeAtlasError ? error.exitCode : 1;
  }
}

await main();
