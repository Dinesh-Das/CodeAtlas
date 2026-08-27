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

export async function ensureFreshIndex(repositoryPath: string): Promise<FreshContext> {
  let status = await getFastStatus(repositoryPath);
  if (!status.synchronized) {
    await refreshOnce(status.root);
    clearFastStatusCache(status.root);
    status = await getFastStatus(repositoryPath);
  }
  if (!status.synchronized) {
    throw new CodeAtlasError(
      "CodeAtlas could not synchronize the graph with the current working tree.",
    );
  }
  return {
    status,
    config: await loadConfig(status.root),
    checkedAt: new Date().toISOString(),
  };
}
