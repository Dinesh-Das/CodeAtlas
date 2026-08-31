import { realpath } from "node:fs/promises";
import path from "node:path";

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function relativePath(root: string, absolutePath: string): string {
  return toPosixPath(path.relative(root, absolutePath));
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve an existing path and reject symlink/junction escapes from the requested root. */
export async function resolveExistingPathInside(
  root: string,
  candidate: string,
): Promise<string | null> {
  try {
    const [resolvedRoot, resolvedCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    return isPathInside(resolvedRoot, resolvedCandidate) ? resolvedCandidate : null;
  } catch {
    return null;
  }
}
