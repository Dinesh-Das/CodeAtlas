import { getStatus, type StatusResult } from "../cli/status.js";
import { indexRepository } from "../cli/index-command.js";
import { loadConfig, type CodeAtlasConfig } from "../core/config.js";
import { CodeAtlasError } from "../core/errors.js";

export interface FreshContext {
  status: StatusResult;
  config: CodeAtlasConfig;
  checkedAt: string;
}

export async function ensureFreshIndex(repositoryPath: string): Promise<FreshContext> {
  let status = await getStatus(repositoryPath);
  if (!status.synchronized) {
    await indexRepository(repositoryPath);
    status = await getStatus(repositoryPath);
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
