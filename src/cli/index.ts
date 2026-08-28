#!/usr/bin/env node
import { Command } from "commander";
import { CodeAtlasError } from "../core/errors.js";
import { CODEATLAS_VERSION } from "../version.js";
import type { IndexProgress } from "../core/telemetry.js";

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
    .action(async (targetPath: string) => {
      const { formatInitResult, initializeRepository } = await import("./init.js");
      console.log(formatInitResult(await initializeRepository(targetPath)));
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
        : (progress: IndexProgress): void => {
            if (progress.status === "completed" && progress.elapsedMs === 0) return;
            const label = progress.phase.replaceAll("_", " ");
            const count = progress.total === null || progress.total === 0
              ? ""
              : ` ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}`;
            const elapsed = progress.status === "started"
              ? ""
              : ` ${(progress.elapsedMs / 1_000).toFixed(2)}s`;
            if (process.stderr.isTTY && progress.status !== "completed") {
              process.stderr.write(`\r${label}${count}${elapsed}`);
            } else if (progress.status === "completed") {
              if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
              process.stderr.write(`${label}${count}${elapsed}\n`);
            }
          };
      const result = await indexRepository(
        targetPath,
        options.full,
        onProgress === undefined ? {} : { onProgress },
      );
      if (options.quiet) return;
      console.log(options.json ? JSON.stringify(result, null, 2) : formatIndexResult(result));
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
