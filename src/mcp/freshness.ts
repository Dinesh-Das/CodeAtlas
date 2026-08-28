import {
  clearFastStatusCache,
  getFastStatus,
  type StatusResult,
} from "../cli/status.js";
import { indexRepository } from "../cli/index-command.js";
import { loadConfig, type CodeAtlasConfig } from "../core/config.js";
import { CodeAtlasError } from "../core/errors.js";

export interface FreshContext {
  status: StatusResult;
  config: CodeAtlasConfig;
  checkedAt: string;
}

export type FreshnessRequirement =
  | "structural"
  | "semantic"
  | "search"
  | "architecture"
  | "all";

const activeRefreshes = new Map<string, Promise<void>>();

async function refreshOnce(repositoryRoot: string): Promise<void> {
  const active = activeRefreshes.get(repositoryRoot);
  if (active !== undefined) return active;
  const refresh = indexRepository(repositoryRoot).then(() => undefined);
  activeRefreshes.set(repositoryRoot, refresh);
  try {
    await refresh;
  } finally {
    if (activeRefreshes.get(repositoryRoot) === refresh) activeRefreshes.delete(repositoryRoot);
  }
}

function satisfies(status: StatusResult, requirement: FreshnessRequirement): boolean {
  switch (requirement) {
    case "structural":
      return status.structuralSynchronized;
    case "semantic":
      return status.structuralSynchronized && status.semanticSynchronized;
    case "search":
      return status.structuralSynchronized && status.searchSynchronized;
    case "architecture":
      return status.structuralSynchronized && status.architectureSynchronized;
    case "all":
      return status.synchronized;
  }
}

export async function ensureFreshIndex(
  repositoryPath: string,
  requirement: FreshnessRequirement = "all",
): Promise<FreshContext> {
  let status = await getFastStatus(repositoryPath);
  if (!satisfies(status, requirement)) {
    await refreshOnce(status.root);
    clearFastStatusCache(status.root);
    status = await getFastStatus(repositoryPath);
  }
  if (!satisfies(status, requirement)) {
    throw new CodeAtlasError(
      `CodeAtlas could not synchronize the ${requirement} index state with the current working tree.`,
    );
  }
  return {
    status,
    config: await loadConfig(status.root),
    checkedAt: new Date().toISOString(),
  };
}
