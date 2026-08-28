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
      return entry[0] === entry[0]?.toLowerCase()
        ? [toPosixPath(entry.slice(2))]
        : [];
    });
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
  const [trackedOutput, stagedOutput, untrackedOutput, statusOutput] = await Promise.all([
    runGit(repository.root, ["diff", "--name-only", "-z", "HEAD", "--"], true),
    runGit(repository.root, ["diff", "--name-only", "--cached", "-z", "HEAD", "--"], true),
    runGit(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    runGit(repository.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  // Keep the two complete-index reads sequential on Windows; concurrent Git readers can
  // transiently fail while a checkout replaces the index file.
  const indexOutput = await runGit(repository.root, ["ls-files", "--stage", "-z"]);
  const verboseFiles = await runGit(repository.root, ["ls-files", "-v", "-z"]);
  const changedPaths = [...new Set([
    ...splitNullDelimited(trackedOutput),
    ...splitNullDelimited(stagedOutput),
    ...splitNullDelimited(untrackedOutput),
    ...assumeUnchangedPaths(verboseFiles),
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
  return {
    signature: sha256(
      `${repository.headCommit}|${sha256(indexOutput)}|${hashSortedEntries(entries)}`,
    ),
    dirty: statusOutput.length > 0,
    changedFiles: changedPaths.length,
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
    runGit(repository.root, ["ls-files", "--stage", "-z"]),
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
