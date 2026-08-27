import { loadConfig } from "../core/config.js";
import { mapWithConcurrency } from "../core/async.js";
import { discoverFiles } from "../core/discovery.js";
import { computeRepositoryFingerprint } from "../core/freshness.js";
import { hashFile, sha256 } from "../core/hashing.js";
import { loadIgnoreRules } from "../core/ignore.js";
import { CodeAtlasError } from "../core/errors.js";
import { workspaceExists, workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import { isWorkingTreeDirty } from "../git/diff.js";
import { openDatabase } from "../storage/database.js";
import { getRepositoryStates } from "../storage/state.js";
import { INDEXER_VERSION, SCHEMA_VERSION } from "../version.js";

export interface StatusResult {
  repository: string;
  root: string;
  branch: string;
  headCommit: string;
  indexedCommit: string | null;
  synchronized: boolean;
  dirty: boolean;
  files: number;
  nodes: number;
  symbols: number;
  edges: number;
  features: number;
  lastIndexedAt: string | null;
  currentFingerprint: string;
  indexedFingerprint: string | null;
}

export async function getStatus(startPath = process.cwd()): Promise<StatusResult> {
  const repository = await detectRepository(startPath);
  if (!(await workspaceExists(repository.root))) {
    throw new CodeAtlasError("Error: CodeAtlas is not initialized. Run `codeatlas init` first.");
  }

  const config = await loadConfig(repository.root);
  const ignoreRules = await loadIgnoreRules(repository.root);
  const discovered = await discoverFiles(repository.root, ignoreRules);
  const hashed = await mapWithConcurrency(discovered, 32, async (file) => ({
      relativePath: file.relativePath,
      contentHash: await hashFile(file.absolutePath),
    }));
  const current = await computeRepositoryFingerprint(repository, hashed, ignoreRules);
  const dirty = await isWorkingTreeDirty(repository.root);
  const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });

  try {
    const state = getRepositoryStates(database);
    const counts = database
      .prepare(
        `SELECT
          (SELECT count(*) FROM files) AS files,
          (SELECT count(*) FROM nodes) AS nodes,
          (SELECT count(*) FROM nodes
            WHERE kind NOT IN ('repository', 'directory', 'file', 'module')) AS symbols,
          (SELECT count(*) FROM edges) AS edges,
          (SELECT count(*) FROM nodes WHERE kind = 'feature') AS features`,
      )
      .get() as { files: number; nodes: number; symbols: number; edges: number; features: number };
    const indexedFingerprint = state.dirty_fingerprint ?? null;
    const configIsCurrent = state.config_hash === sha256(JSON.stringify(config));
    const indexContractIsCurrent =
      state.indexer_version === INDEXER_VERSION &&
      state.schema_version === String(SCHEMA_VERSION);

    return {
      repository: repository.name,
      root: repository.root,
      branch: repository.branch,
      headCommit: repository.headCommit,
      indexedCommit: state.last_indexed_commit ?? null,
      synchronized:
        indexedFingerprint === current.fingerprint && configIsCurrent && indexContractIsCurrent,
      dirty,
      files: counts.files,
      nodes: counts.nodes,
      symbols: counts.symbols,
      edges: counts.edges,
      features: counts.features,
      lastIndexedAt: state.last_indexed_at ?? null,
      currentFingerprint: current.fingerprint,
      indexedFingerprint,
    };
  } finally {
    database.close();
  }
}

export function formatStatus(result: StatusResult): string {
  return [
    `Repository: ${result.repository}`,
    `Branch: ${result.branch}`,
    `HEAD: ${result.headCommit}`,
    `Working tree: ${result.dirty ? "dirty" : "clean"}`,
    "",
    "Index:",
    `  Status: ${result.synchronized ? "up to date" : "out of date"}`,
    `  Files: ${result.files}`,
    `  Symbols: ${result.symbols}`,
    `  Relationships: ${result.edges}`,
    `  Features: ${result.features}`,
    "",
    `Last indexed: ${result.lastIndexedAt ?? "never"}`,
  ].join("\n");
}
