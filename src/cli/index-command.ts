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
    result.deletedFiles > 0 ? `✓ Removed ${result.deletedFiles} deleted files` : null,
    `✓ Graph contains ${result.nodes} nodes and ${result.edges} relationships`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
