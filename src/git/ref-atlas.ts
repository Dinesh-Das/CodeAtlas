import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildRepository } from "../compiler/build.js";
import type { Atlas } from "../ir/models.js";
import { assertValidAtlas } from "../ir/validation.js";
import { detectRepository, runGit } from "./repository.js";
import { withDetachedWorktree } from "./worktree.js";

async function readBuiltAtlas(currentDirectory: string): Promise<Atlas> {
  const atlas = JSON.parse(
    await readFile(path.join(currentDirectory, "atlas.json"), "utf8"),
  ) as Atlas;
  assertValidAtlas(atlas);
  return atlas;
}

/**
 * Build an Atlas for an arbitrary Git head without changing the user's checkout.
 * Base/head options remain deterministic because the detached worktree resolves
 * refs using the same repository object database and refs as the main checkout.
 */
export async function buildAtlasAtGitHead(
  startPath: string,
  base: string,
  head: string,
  options: { snapshot?: boolean } = {},
): Promise<Atlas> {
  const repository = await detectRepository(startPath);
  if (!repository.gitAvailable) {
    const build = await buildRepository(startPath, {
      gitBase: base,
      gitHead: head,
      snapshot: options.snapshot ?? false,
    });
    return readBuiltAtlas(build.currentDirectory);
  }

  const resolvedHead = (await runGit(repository.root, ["rev-parse", head])).trim();
  if (resolvedHead === repository.headCommit) {
    const build = await buildRepository(repository.root, {
      gitBase: base,
      gitHead: head,
      snapshot: options.snapshot ?? false,
    });
    return readBuiltAtlas(build.currentDirectory);
  }

  return withDetachedWorktree(repository.root, resolvedHead, async (worktreeRoot) => {
    const build = await buildRepository(worktreeRoot, {
      gitBase: base,
      gitHead: "HEAD",
      snapshot: false,
      bundle: false,
    });
    return readBuiltAtlas(build.currentDirectory);
  });
}
