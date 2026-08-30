import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "./repository.js";

/**
 * Execute read-only architecture work against an arbitrary Git ref without
 * touching the user's checked-out worktree.
 */
export async function withDetachedWorktree<T>(
  repositoryRoot: string,
  ref: string,
  callback: (worktreeRoot: string) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codeatlas-ref-"));
  const worktreeRoot = path.join(temporaryRoot, "repo");
  let registered = false;
  try {
    await runGit(repositoryRoot, ["worktree", "add", "--detach", worktreeRoot, ref]);
    registered = true;
    return await callback(worktreeRoot);
  } finally {
    if (registered) {
      await runGit(repositoryRoot, ["worktree", "remove", "--force", worktreeRoot], true);
      await runGit(repositoryRoot, ["worktree", "prune"], true);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
