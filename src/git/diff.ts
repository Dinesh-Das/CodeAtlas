import { runGit } from "./repository.js";

export async function isWorkingTreeDirty(repositoryRoot: string): Promise<boolean> {
  const output = await runGit(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  return output.length > 0;
}
