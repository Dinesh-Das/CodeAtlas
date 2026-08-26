import { stat } from "node:fs/promises";
import { createDefaultConfig } from "../core/config.js";
import { ensureCodeAtlasIgnored } from "../core/ignore.js";
import { ensureWorkspaceDirectories, workspaceExists, workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import { runIndex, type IndexResult } from "../indexer/indexer.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export interface InitResult extends IndexResult {
  addedToGitignore: boolean;
  createdWorkspace: boolean;
}

export async function initializeRepository(startPath = process.cwd()): Promise<InitResult> {
  const repository = await detectRepository(startPath);
  const paths = workspacePaths(repository.root);
  const createdWorkspace = !(await workspaceExists(repository.root));
  const hadDatabase = await fileExists(paths.database);

  await ensureWorkspaceDirectories(repository.root);
  const addedToGitignore = await ensureCodeAtlasIgnored(repository.root);

  if (!(await fileExists(paths.config))) {
    if (hadDatabase) {
      throw new Error(
        "Error: .codeatlas/config.json is missing from an existing workspace. Run `codeatlas doctor` for details.",
      );
    }
    await createDefaultConfig(repository.root);
  }

  const result = await runIndex({ startPath: repository.root, full: createdWorkspace || !hadDatabase });
  return { ...result, addedToGitignore, createdWorkspace };
}

export function formatInitResult(result: InitResult): string {
  const languageNames = Object.entries(result.languages)
    .filter(([, count]) => count > 0)
    .map(([language]) => language)
    .join(", ");

  return [
    "✓ Repository detected",
    languageNames ? `✓ Languages detected: ${languageNames}` : "✓ No supported languages detected",
    result.addedToGitignore
      ? "✓ Added .codeatlas/ to .gitignore"
      : "✓ .codeatlas/ already ignored",
    `✓ Indexed ${result.files} files`,
    `✓ Created ${result.nodes} graph nodes`,
    `✓ Created ${result.edges} graph relationships`,
    "✓ CodeAtlas foundation is ready",
    "",
    "Run:",
    "  codeatlas status",
  ].join("\n");
}
