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
