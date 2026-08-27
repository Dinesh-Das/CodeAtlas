import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { IgnoreRules } from "./ignore.js";
import { isPathInside, relativePath } from "./paths.js";

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

export async function discoverFiles(
  repositoryRoot: string,
  ignoreRules: IgnoreRules,
): Promise<DiscoveredFile[]> {
  const rootRealPath = await realpath(repositoryRoot);
  const files: DiscoveredFile[] = [];
  const visitedDirectories = new Set<string>();

  async function visit(directoryPath: string): Promise<void> {
    const directoryRealPath = await realpath(directoryPath);
    if (!isPathInside(rootRealPath, directoryRealPath) || visitedDirectories.has(directoryRealPath)) {
      return;
    }
    visitedDirectories.add(directoryRealPath);

    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry.name);
      const relative = relativePath(repositoryRoot, absolutePath);
      const entryLstat = await lstat(absolutePath);

      if (entryLstat.isSymbolicLink()) {
        const target = await realpath(absolutePath).catch(() => null);
        if (target === null || !isPathInside(rootRealPath, target)) continue;
        const targetStat = await stat(target);
        if (targetStat.isDirectory()) {
          if (!ignoreRules.ignores(relative, true)) await visit(absolutePath);
        } else if (targetStat.isFile() && !ignoreRules.ignores(relative)) {
          files.push({
            absolutePath,
            relativePath: relative,
            sizeBytes: targetStat.size,
            mtimeMs: targetStat.mtimeMs,
            ctimeMs: targetStat.ctimeMs,
          });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!ignoreRules.ignores(relative, true)) await visit(absolutePath);
      } else if (entry.isFile() && !ignoreRules.ignores(relative)) {
        files.push({
          absolutePath,
          relativePath: relative,
          sizeBytes: entryLstat.size,
          mtimeMs: entryLstat.mtimeMs,
          ctimeMs: entryLstat.ctimeMs,
        });
      }
    }
  }

  await visit(repositoryRoot);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
