import type { RepositoryInfo } from "../git/repository.js";
import { runGit } from "../git/repository.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { hashFile, hashSortedEntries, sha256 } from "./hashing.js";
import type { IgnoreRules } from "./ignore.js";
import { toPosixPath } from "./paths.js";

export interface HashedWorkingFile {
  relativePath: string;
  contentHash: string;
}

export interface RepositoryFingerprint {
  fingerprint: string;
  headCommit: string;
  trackedHash: string;
  untrackedHash: string;
  indexHash: string;
}

export interface WorktreeSignature {
  signature: string;
  dirty: boolean;
  changedFiles: number;
  changedPaths: string[];
  trackedPaths: string[];
  untrackedPaths: string[];
  indexHash: string;
  statusOutput: string;
}

interface CachedHash {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  hash: string;
}

const worktreeHashCache = new Map<string, CachedHash>();

function splitNullDelimited(output: string): string[] {
  return output
    .split("\0")
    .map((entry) => toPosixPath(entry))
    .filter((entry) => entry.length > 0);
}

function assumeUnchangedPaths(output: string): string[] {
  return output
    .split("\0")
    .flatMap((entry) => {
      if (entry.length < 3 || entry[1] !== " ") return [];
      const tab = entry.indexOf("\t");
      return entry[0] === entry[0]?.toLowerCase()
        ? [toPosixPath(tab < 0 ? entry.slice(2) : entry.slice(tab + 1))]
        : [];
    });
}

function stagedPaths(output: string): string[] {
  return output
    .split("\0")
    .flatMap((entry) => {
      const tab = entry.indexOf("\t");
      return tab < 0 ? [] : [toPosixPath(entry.slice(tab + 1))];
    })
    .filter((entry) => entry.length > 0);
}

function porcelainPaths(output: string): {
  changedPaths: string[];
  untrackedPaths: string[];
} {
  const entries = output.split("\0");
  const changedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const filePath = toPosixPath(entry.slice(3));
    if (filePath.length > 0) changedPaths.push(filePath);
    if (status === "??" && filePath.length > 0) untrackedPaths.push(filePath);
    if (status.includes("R") || status.includes("C")) {
      const originalPath = toPosixPath(entries[index + 1] ?? "");
      if (originalPath.length > 0) changedPaths.push(originalPath);
      index += 1;
    }
  }
  return { changedPaths, untrackedPaths };
}

async function cachedFileHash(absolutePath: string): Promise<string> {
  const metadata = await stat(absolutePath);
  const cached = worktreeHashCache.get(absolutePath);
  if (
    cached !== undefined &&
    cached.size === metadata.size &&
    cached.mtimeMs === metadata.mtimeMs &&
    cached.ctimeMs === metadata.ctimeMs
  ) {
    return cached.hash;
  }
  const hash = await hashFile(absolutePath);
  worktreeHashCache.set(absolutePath, {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    hash,
  });
  if (worktreeHashCache.size > 10_000) {
    worktreeHashCache.delete(worktreeHashCache.keys().next().value!);
  }
  return hash;
}

/**
 * Computes freshness from Git's changed-path index and hashes only dirty paths. This
 * avoids rediscovering and fingerprinting every repository file for each MCP request.
 */
export async function computeWorktreeSignature(
  repository: RepositoryInfo,
  ignoreRules: IgnoreRules,
): Promise<WorktreeSignature> {
  // Git for Windows can transiently reject concurrent reads while another
  // process replaces the index, so keep the complete-index reads sequential.
  const statusOutput = await runGit(repository.root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const indexOutput = await runGit(repository.root, ["ls-files", "--stage", "-v", "-z"]);
  const status = porcelainPaths(statusOutput);
  const changedPaths = [...new Set([
    ...status.changedPaths,
    ...assumeUnchangedPaths(indexOutput),
  ])]
    .filter((filePath) => !ignoreRules.ignores(filePath))
    .sort((left, right) => left.localeCompare(right));
  const entries = await Promise.all(changedPaths.map(async (filePath) => {
    const absolutePath = path.join(repository.root, ...filePath.split("/"));
    try {
      return `${filePath}:${await cachedFileHash(absolutePath)}`;
    } catch {
      return `${filePath}:__deleted__`;
    }
  }));
  const trackedPaths = stagedPaths(indexOutput)
    .filter((filePath) => !ignoreRules.ignores(filePath))
    .sort((left, right) => left.localeCompare(right));
  const untrackedPaths = status.untrackedPaths
    .filter((filePath) => !ignoreRules.ignores(filePath))
    .sort((left, right) => left.localeCompare(right));
  const indexHash = sha256(indexOutput);
  return {
    signature: sha256(
      `${repository.headCommit}|${indexHash}|${hashSortedEntries(entries)}`,
    ),
    dirty: changedPaths.length > 0,
    changedFiles: changedPaths.length,
    changedPaths,
    trackedPaths,
    untrackedPaths,
    indexHash,
    statusOutput,
  };
}

export function repositoryFingerprintFromWorktree(
  repository: RepositoryInfo,
  files: readonly HashedWorkingFile[],
  worktree: WorktreeSignature,
): RepositoryFingerprint {
  const fileHashes = new Map(files.map((file) => [file.relativePath, file.contentHash]));
  const trackedHash = hashSortedEntries(
    worktree.trackedPaths.map((filePath) => `${filePath}:${fileHashes.get(filePath) ?? "__deleted__"}`),
  );
  const untrackedHash = hashSortedEntries(
    worktree.untrackedPaths.flatMap((filePath) => {
      const contentHash = fileHashes.get(filePath);
      return contentHash === undefined ? [] : [`${filePath}:${contentHash}`];
    }),
  );
  return {
    fingerprint: sha256(`${repository.headCommit}|${worktree.indexHash}|${trackedHash}|${untrackedHash}`),
    headCommit: repository.headCommit,
    trackedHash,
    untrackedHash,
    indexHash: worktree.indexHash,
  };
}

export async function computeRepositoryFingerprint(
  repository: RepositoryInfo,
  files: readonly HashedWorkingFile[],
  ignoreRules: IgnoreRules,
): Promise<RepositoryFingerprint> {
  const [trackedOutput, untrackedOutput, indexOutput] = await Promise.all([
    runGit(repository.root, ["ls-files", "--cached", "-z"]),
    runGit(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    runGit(repository.root, ["ls-files", "--stage", "-v", "-z"]),
  ]);
  const fileHashes = new Map(files.map((file) => [file.relativePath, file.contentHash]));

  const trackedEntries = splitNullDelimited(trackedOutput)
    .filter((filePath) => !ignoreRules.ignores(filePath))
    .map((filePath) => `${filePath}:${fileHashes.get(filePath) ?? "__deleted__"}`);
  const untrackedEntries = splitNullDelimited(untrackedOutput)
    .filter((filePath) => !ignoreRules.ignores(filePath))
    .flatMap((filePath) => {
      const contentHash = fileHashes.get(filePath);
      return contentHash === undefined ? [] : [`${filePath}:${contentHash}`];
    });

  const trackedHash = hashSortedEntries(trackedEntries);
  const untrackedHash = hashSortedEntries(untrackedEntries);
  const indexHash = sha256(indexOutput);
  return {
    fingerprint: sha256(
      `${repository.headCommit}|${indexHash}|${trackedHash}|${untrackedHash}`,
    ),
    headCommit: repository.headCommit,
    trackedHash,
    untrackedHash,
    indexHash,
  };
}
