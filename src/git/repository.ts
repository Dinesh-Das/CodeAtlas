import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { CodeAtlasError } from "../core/errors.js";
import { sha256 } from "../core/hashing.js";

const execFile = promisify(execFileCallback);

export interface RepositoryInfo {
  root: string;
  id: string;
  name: string;
  headCommit: string;
  branch: string;
}

export async function runGit(
  repositoryRoot: string,
  args: readonly string[],
  allowFailure = false,
): Promise<string> {
  try {
    const { stdout } = await execFile("git", [...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

export async function detectRepository(startPath = process.cwd()): Promise<RepositoryInfo> {
  let rootOutput: string;
  try {
    rootOutput = await runGit(startPath, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    throw new CodeAtlasError(
      "Error: CodeAtlas requires a Git repository. Non-Git directories are not supported in V1.",
      { cause: error },
    );
  }

  const reportedRoot = rootOutput.trim();
  if (!reportedRoot) {
    throw new CodeAtlasError(
      "Error: CodeAtlas requires a Git repository. Non-Git directories are not supported in V1.",
    );
  }

  const root = await realpath(path.resolve(reportedRoot));
  const [headOutput, branchOutput] = await Promise.all([
    runGit(root, ["rev-parse", "HEAD"], true),
    runGit(root, ["branch", "--show-current"], true),
  ]);
  const headCommit = headOutput.trim() || "unborn";
  const branch = branchOutput.trim() || "detached";

  return {
    root,
    id: sha256(root),
    name: path.basename(root),
    headCommit,
    branch,
  };
}
