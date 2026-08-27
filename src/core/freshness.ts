import type { RepositoryInfo } from "../git/repository.js";
import { runGit } from "../git/repository.js";
import { hashSortedEntries, sha256 } from "./hashing.js";
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

function splitNullDelimited(output: string): string[] {
  return output
    .split("\0")
    .map((entry) => toPosixPath(entry))
    .filter((entry) => entry.length > 0);
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
