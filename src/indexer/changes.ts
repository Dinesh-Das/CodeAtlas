import type { GitState } from "../git/changes.js";

export interface RenameChange {
  previousPath: string;
  path: string;
  similarity: number;
}

export interface RepositoryChanges<TCurrent> {
  added: TCurrent[];
  modified: TCurrent[];
  deleted: string[];
  renamed: Array<RenameChange & { current: TCurrent }>;
}

function acceptedRenames<TCurrent>(
  existingPaths: ReadonlySet<string>,
  currentByPath: ReadonlyMap<string, TCurrent>,
  gitState: GitState,
  pathAliases: ReadonlyMap<string, string>,
): Array<RenameChange & { current: TCurrent }> {
  const nextByPath = new Map(
    gitState.renames.map((rename) => {
      const previousPath = pathAliases.get(rename.previousPath) ?? rename.previousPath;
      return [previousPath, { ...rename, previousPath }] as const;
    }),
  );
  const usedTargets = new Set<string>();
  const result: Array<RenameChange & { current: TCurrent }> = [];

  for (const previousPath of [...existingPaths].sort((left, right) => left.localeCompare(right))) {
    if (currentByPath.has(previousPath)) continue;
    let path = previousPath;
    let similarity = 1;
    const visited = new Set<string>();
    while (!visited.has(path)) {
      visited.add(path);
      const rename = nextByPath.get(path);
      if (rename === undefined) break;
      path = rename.path;
      similarity = Math.min(similarity, rename.similarity);
    }
    const current = currentByPath.get(path);
    if (
      current === undefined ||
      existingPaths.has(path) ||
      usedTargets.has(path) ||
      similarity < 0.5
    ) {
      continue;
    }
    usedTargets.add(path);
    result.push({ previousPath, path, similarity, current });
  }
  return result;
}

export function classifyRepositoryChanges<TCurrent>(
  existingPaths: ReadonlySet<string>,
  current: readonly TCurrent[],
  gitState: GitState,
  pathOf: (current: TCurrent) => string,
  isModified: (current: TCurrent) => boolean,
  pathAliases: ReadonlyMap<string, string> = new Map(),
): RepositoryChanges<TCurrent> {
  const currentByPath = new Map(current.map((entry) => [pathOf(entry), entry]));
  const renamed = acceptedRenames(existingPaths, currentByPath, gitState, pathAliases);
  const renamedSources = new Set(renamed.map((rename) => rename.previousPath));
  const renamedTargets = new Set(renamed.map((rename) => rename.path));

  return {
    added: current.filter(
      (entry) => !existingPaths.has(pathOf(entry)) && !renamedTargets.has(pathOf(entry)),
    ),
    modified: current.filter(
      (entry) => existingPaths.has(pathOf(entry)) && isModified(entry),
    ),
    deleted: [...existingPaths]
      .filter((filePath) => !currentByPath.has(filePath) && !renamedSources.has(filePath))
      .sort((left, right) => left.localeCompare(right)),
    renamed,
  };
}
