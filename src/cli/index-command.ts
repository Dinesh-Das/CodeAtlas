import { workspaceExists } from "../core/workspace.js";
import { CodeAtlasError } from "../core/errors.js";
import { detectRepository } from "../git/repository.js";
import { runIndex, type IndexResult } from "../indexer/indexer.js";

export async function indexRepository(
  startPath = process.cwd(),
  full = false,
): Promise<IndexResult> {
  const repository = await detectRepository(startPath);
  if (!(await workspaceExists(repository.root))) {
    throw new CodeAtlasError("Error: CodeAtlas is not initialized. Run `codeatlas init` first.");
  }
  return runIndex({ startPath: repository.root, full });
}

export function formatIndexResult(result: IndexResult): string {
  return [
    `✓ Indexed ${result.files} files`,
    `✓ Updated ${result.changedFiles} files`,
    result.addedFiles > 0 ? `✓ Added ${result.addedFiles} files` : null,
    result.modifiedFiles > 0 ? `✓ Modified ${result.modifiedFiles} files` : null,
    result.renamedFiles > 0 ? `✓ Preserved identity for ${result.renamedFiles} renamed files` : null,
    result.invalidatedFiles > 0
      ? `✓ Recomputed ${result.invalidatedFiles} dependent files`
      : null,
    result.deletedFiles > 0 ? `✓ Removed ${result.deletedFiles} deleted files` : null,
    result.fullRebuild ? "✓ Completed a required full graph rebuild" : null,
    result.apiRoutes > 0 ? `✓ Detected ${result.apiRoutes} API routes` : null,
    result.databaseModels > 0
      ? `✓ Detected ${result.databaseModels} database models`
      : null,
    result.features > 0 ? `✓ Grouped ${result.features} features` : null,
    result.domains > 0 ? `✓ Identified ${result.domains} domains` : null,
    result.communities > 0
      ? `✓ Found ${result.communities} dependency communities`
      : null,
    result.findings > 0
      ? `! Recorded ${result.findings} architecture signals`
      : "✓ No architecture signals crossed configured thresholds",
    `✓ Graph contains ${result.symbols} symbols and ${result.edges} relationships`,
    result.parseErrors > 0 ? `! ${result.parseErrors} files contain parse errors` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
