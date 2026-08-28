import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
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
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { stdout } = await execFile("git", [...args], {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      lastError = error;
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      const transientWindowsIndexRead = process.platform === "win32" &&
        /\.git\/index: index file open failed: Permission denied/iu.test(stderr);
      if (transientWindowsIndexRead && attempt < 2) {
        await delay(20 * (attempt + 1));
        continue;
      }
      if (allowFailure) return "";
      throw error;
    }
  }
  if (allowFailure) return "";
  throw lastError;
}

export async function detectRepository(startPath = process.cwd()): Promise<RepositoryInfo> {
  let combinedOutput: string;
  try {
    combinedOutput = await runGit(startPath, [
      "rev-parse",
      "--show-toplevel",
      "HEAD",
      "--abbrev-ref",
      "HEAD",
    ]);
  } catch (error) {
    // An unborn repository has no HEAD, so retain the more permissive fallback.
    let rootOutput: string;
    try {
      rootOutput = await runGit(startPath, ["rev-parse", "--show-toplevel"]);
    } catch {
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
    const branch = (await runGit(root, ["branch", "--show-current"], true)).trim() || "detached";
    return {
      root,
      id: sha256(root),
      name: path.basename(root),
      headCommit: "unborn",
      branch,
    };
  }

  const [reportedRoot = "", headCommit = "", reportedBranch = ""] = combinedOutput
    .trimEnd()
    .split(/\r?\n/u);
  if (!reportedRoot) {
    throw new CodeAtlasError(
      "Error: CodeAtlas requires a Git repository. Non-Git directories are not supported in V1.",
    );
  }

  const root = await realpath(path.resolve(reportedRoot));
  const branch = reportedBranch === "HEAD" ? "detached" : reportedBranch || "detached";

  return {
    root,
    id: sha256(root),
    name: path.basename(root),
    headCommit,
    branch,
  };
}
