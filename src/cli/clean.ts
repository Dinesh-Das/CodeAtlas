import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { removeWorkspace, workspaceExists } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";

export async function cleanRepository(startPath = process.cwd(), force = false): Promise<boolean> {
  const repository = await detectRepository(startPath);
  if (!(await workspaceExists(repository.root))) return false;

  if (!force) {
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error("Refusing to clean non-interactively without `--force`.");
    }
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await prompt.question("Delete the local .codeatlas/ index? [y/N] ");
      if (!/^(y|yes)$/iu.test(answer.trim())) return false;
    } finally {
      prompt.close();
    }
  }

  await removeWorkspace(repository.root);
  return true;
}
