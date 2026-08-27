#!/usr/bin/env node
import { Command } from "commander";
import { CodeAtlasError } from "../core/errors.js";
import { CODEATLAS_VERSION } from "../version.js";
import { cleanRepository } from "./clean.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { formatIndexResult, indexRepository } from "./index-command.js";
import { formatInitResult, initializeRepository } from "./init.js";
import { startMcpServer } from "./mcp.js";
import { formatStatus, getStatus } from "./status.js";

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
      console.log(formatInitResult(await initializeRepository(targetPath)));
    });

  program
    .command("index")
    .description("Synchronize the local CodeAtlas index.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--full", "Rebuild the complete index", false)
    .action(async (targetPath: string, options: { full: boolean }) => {
      console.log(formatIndexResult(await indexRepository(targetPath, options.full)));
    });

  program
    .command("status")
    .description("Show repository and index synchronization status.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--json", "Print machine-readable JSON", false)
    .action(async (targetPath: string, options: { json: boolean }) => {
      const result = await getStatus(targetPath);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatStatus(result));
    });

  program
    .command("doctor")
    .description("Validate Git, configuration, storage, and runtime prerequisites.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .action(async (targetPath: string) => {
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
    .action(async (targetPath: string) => startMcpServer(targetPath));

  program
    .command("clean")
    .description("Delete the local CodeAtlas index safely.")
    .argument("[path]", "A path inside the repository", process.cwd())
    .option("--force", "Skip the confirmation prompt", false)
    .action(async (targetPath: string, options: { force: boolean }) => {
      const removed = await cleanRepository(targetPath, options.force);
      console.log(removed ? "✓ Removed .codeatlas/" : "CodeAtlas workspace was not removed.");
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
