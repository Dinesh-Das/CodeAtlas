import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CodeAtlasError } from "../core/errors.js";
import { sha256 } from "../core/hashing.js";

const execFile = promisify(execFileCallback);

export interface RepositoryInfo {
  root: string;
  id: string;
  name: string;
  gitAvailable: boolean;
  headCommit: string;
  branch: string;
}

export const FILESYSTEM_HEAD = "filesystem";
export const FILESYSTEM_BRANCH = "filesystem";

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
        /\.git(?:\/worktrees\/[^/]+)?\/index: index file open failed: Permission denied/iu.test(stderr);
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
  let candidate: string;
  try {
    const resolved = path.resolve(startPath);
    const metadata = await stat(resolved);
    candidate = metadata.isDirectory() ? resolved : path.dirname(resolved);
    candidate = await realpath(candidate);
  } catch (error) {
    throw new CodeAtlasError(`Error: Repository path does not exist: ${path.resolve(startPath)}`, {
      cause: error,
    });
  }

  let combinedOutput: string;
  try {
    combinedOutput = await runGit(candidate, [
      "rev-parse",
      "--show-toplevel",
      "HEAD",
      "--abbrev-ref",
      "HEAD",
    ]);
  } catch {
    // An unborn repository has no HEAD, so retain the more permissive fallback.
    let rootOutput: string;
    try {
      rootOutput = await runGit(candidate, ["rev-parse", "--show-toplevel"]);
    } catch {
      return {
        root: candidate,
        id: sha256(candidate),
        name: path.basename(candidate),
        gitAvailable: false,
        headCommit: FILESYSTEM_HEAD,
        branch: FILESYSTEM_BRANCH,
      };
    }
    const reportedRoot = rootOutput.trim();
    if (!reportedRoot) {
      return {
        root: candidate,
        id: sha256(candidate),
        name: path.basename(candidate),
        gitAvailable: false,
        headCommit: FILESYSTEM_HEAD,
        branch: FILESYSTEM_BRANCH,
      };
    }
    const root = await realpath(path.resolve(reportedRoot));
    const branch = (await runGit(root, ["branch", "--show-current"], true)).trim() || "detached";
    return {
      root,
      id: sha256(root),
      name: path.basename(root),
      gitAvailable: true,
      headCommit: "unborn",
      branch,
    };
  }

  const [reportedRoot = "", headCommit = "", reportedBranch = ""] = combinedOutput
    .trimEnd()
    .split(/\r?\n/u);
  if (!reportedRoot) {
    return {
      root: candidate,
      id: sha256(candidate),
      name: path.basename(candidate),
      gitAvailable: false,
      headCommit: FILESYSTEM_HEAD,
      branch: FILESYSTEM_BRANCH,
    };
  }

  const root = await realpath(path.resolve(reportedRoot));
  const branch = reportedBranch === "HEAD" ? "detached" : reportedBranch || "detached";

  return {
    root,
    id: sha256(root),
    name: path.basename(root),
    gitAvailable: true,
    headCommit,
    branch,
  };
}
