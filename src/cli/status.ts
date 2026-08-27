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
import { listFiles } from "../storage/files.js";
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
  apiRoutes: number;
  databaseModels: number;
  domains: number;
  communities: number;
  cycles: number;
  hotspots: number;
  findings: number;
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
  const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
  const state = getRepositoryStates(database);
  const existing = state.schema_version === String(SCHEMA_VERSION)
    ? new Map(listFiles(database).map((file) => [file.path, file]))
    : new Map();
  const hashed = await mapWithConcurrency(discovered, 32, async (file) => ({
      relativePath: file.relativePath,
      contentHash: (() => {
        const previous = existing.get(file.relativePath);
        return previous !== undefined &&
          previous.sizeBytes === file.sizeBytes &&
          previous.mtimeMs === file.mtimeMs &&
          previous.ctimeMs === file.ctimeMs
          ? previous.contentHash
          : null;
      })() ?? await hashFile(file.absolutePath),
    }));
  const current = await computeRepositoryFingerprint(repository, hashed, ignoreRules);
  const dirty = await isWorkingTreeDirty(repository.root);

  try {
    const baseCounts = database
      .prepare(
        `SELECT
          (SELECT count(*) FROM files) AS files,
          (SELECT count(*) FROM nodes) AS nodes,
          (SELECT count(*) FROM nodes
            WHERE kind NOT IN (
              'repository', 'directory', 'file', 'module', 'feature', 'domain',
              'documentation'
            )) AS symbols,
          (SELECT count(*) FROM edges) AS edges,
          (SELECT count(*) FROM nodes WHERE kind = 'feature') AS features,
          (SELECT count(*) FROM nodes WHERE kind = 'api_route') AS apiRoutes,
          (SELECT count(*) FROM nodes WHERE kind = 'database_model') AS databaseModels,
          (SELECT count(*) FROM nodes WHERE kind = 'domain') AS domains`,
      )
      .get() as {
        files: number;
        nodes: number;
        symbols: number;
        edges: number;
        features: number;
        apiRoutes: number;
        databaseModels: number;
        domains: number;
      };
    const architectureCounts =
      state.schema_version === String(SCHEMA_VERSION)
        ? (database
            .prepare(
              `SELECT
                 (SELECT count(DISTINCT community_id)
                    FROM dependency_communities) AS communities,
                 (SELECT count(*) FROM architecture_findings
                    WHERE finding_type = 'circular_dependency') AS cycles,
                 (SELECT count(*) FROM architecture_findings
                    WHERE finding_type = 'change_hotspot') AS hotspots,
                 (SELECT count(*) FROM architecture_findings) AS findings`,
            )
            .get() as {
            communities: number;
            cycles: number;
            hotspots: number;
            findings: number;
          })
        : { communities: 0, cycles: 0, hotspots: 0, findings: 0 };
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
      files: baseCounts.files,
      nodes: baseCounts.nodes,
      symbols: baseCounts.symbols,
      edges: baseCounts.edges,
      features: baseCounts.features,
      apiRoutes: baseCounts.apiRoutes,
      databaseModels: baseCounts.databaseModels,
      domains: baseCounts.domains,
      communities: architectureCounts.communities,
      cycles: architectureCounts.cycles,
      hotspots: architectureCounts.hotspots,
      findings: architectureCounts.findings,
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
    `  API routes: ${result.apiRoutes}`,
    `  Database models: ${result.databaseModels}`,
    `  Features: ${result.features}`,
    `  Domains: ${result.domains}`,
    `  Dependency communities: ${result.communities}`,
    `  Architecture signals: ${result.findings}`,
    `  Circular dependencies: ${result.cycles}`,
    `  Change hotspots: ${result.hotspots}`,
    "",
    `Last indexed: ${result.lastIndexedAt ?? "never"}`,
  ].join("\n");
}
