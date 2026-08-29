import { stat } from "node:fs/promises";
import { createDefaultConfig } from "../core/config.js";
import { ensureCodeAtlasIgnored } from "../core/ignore.js";
import { ensureWorkspaceDirectories, workspaceExists, workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import { runIndex, type IndexResult } from "../indexer/indexer.js";
import type { IndexProgress } from "../core/telemetry.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export interface InitResult extends IndexResult {
  addedToIgnore: boolean;
  addedToGitignore: boolean;
  createdWorkspace: boolean;
  ignoreScope: "local" | "shared";
}

export async function initializeRepository(
  startPath = process.cwd(),
  options: {
    sharedIgnore?: boolean;
    onProgress?: (progress: IndexProgress) => void;
  } = {},
): Promise<InitResult> {
  const repository = await detectRepository(startPath);
  const paths = workspacePaths(repository.root);
  const createdWorkspace = !(await workspaceExists(repository.root));
  const hadDatabase = await fileExists(paths.database);

  await ensureWorkspaceDirectories(repository.root);
  const ignoreScope = options.sharedIgnore === true ? "shared" : "local";
  const addedToIgnore = await ensureCodeAtlasIgnored(repository.root, options.sharedIgnore === true);

  if (!(await fileExists(paths.config))) {
    if (hadDatabase) {
      throw new Error(
        "Error: .codeatlas/config.json is missing from an existing workspace. Run `codeatlas doctor` for details.",
      );
    }
    await createDefaultConfig(repository.root);
  }

  const result = await runIndex({
    startPath: repository.root,
    full: createdWorkspace || !hadDatabase,
    precomputedRepository: repository,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  return {
    ...result,
    addedToIgnore,
    addedToGitignore: options.sharedIgnore === true && addedToIgnore,
    createdWorkspace,
    ignoreScope,
  };
}

export function formatInitResult(result: InitResult): string {
  const languageNames = Object.entries(result.languages)
    .filter(([, count]) => count > 0)
    .map(([language]) => language)
    .join(", ");

  return [
    "[OK] Repository detected",
    languageNames ? `[OK] Languages detected: ${languageNames}` : "[OK] No supported languages detected",
    result.addedToIgnore
      ? result.ignoreScope === "shared"
        ? "[OK] Added .codeatlas/ to .gitignore (--shared-ignore)"
        : "[OK] Excluded .codeatlas/ locally via Git info/exclude"
      : "[OK] .codeatlas/ already ignored",
    `[OK] Indexed ${result.files} files`,
    `[OK] Extracted ${result.symbols} symbols`,
    `[OK] Created ${result.edges} graph relationships`,
    result.apiRoutes > 0 ? `[OK] Detected ${result.apiRoutes} API routes` : null,
    result.databaseModels > 0
      ? `[OK] Detected ${result.databaseModels} database models`
      : null,
    result.features > 0 ? `[OK] Grouped ${result.features} features` : null,
    result.domains > 0 ? `[OK] Identified ${result.domains} domains` : null,
    result.findings > 0
      ? `[!] Recorded ${result.findings} architecture signals`
      : "[OK] No architecture signals crossed configured thresholds",
    result.parseErrors > 0
      ? `[!] ${result.parseErrors} files contain parse errors`
      : "[OK] All supported source files parsed",
    "[OK] CodeAtlas is ready",
    "",
    "Run:",
    "  codeatlas overview",
    "  codeatlas setup",
    "  codeatlas status",
    "  codeatlas mcp",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
