import { mapWithConcurrency } from "../core/async.js";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { loadConfig, type CodeAtlasConfig } from "../core/config.js";
import { discoverFiles } from "../core/discovery.js";
import { CodeAtlasError } from "../core/errors.js";
import {
  computeRepositoryFingerprint,
  computeWorktreeSignature,
  type WorktreeSignature,
} from "../core/freshness.js";
import { hashFile, sha256 } from "../core/hashing.js";
import { loadIgnoreRules } from "../core/ignore.js";
import type { IgnoreRules } from "../core/ignore.js";
import { workspaceExists, workspacePaths } from "../core/workspace.js";
import { isWorkingTreeDirty } from "../git/diff.js";
import { detectRepository, type RepositoryInfo } from "../git/repository.js";
import { openDatabase, type AtlasDatabase } from "../storage/database.js";
import { listFiles } from "../storage/files.js";
import { TREE_SITTER_VERSION } from "../parser/registry.js";
import {
  generationsFromState,
  getRepositoryStates,
  type RepositoryGenerations,
} from "../storage/state.js";
import { INDEXER_VERSION, SCHEMA_VERSION } from "../version.js";

export interface StatusResult {
  repository: string;
  root: string;
  gitAvailable: boolean;
  branch: string;
  headCommit: string;
  indexedCommit: string | null;
  synchronized: boolean;
  structuralSynchronized: boolean;
  semanticSynchronized: boolean;
  searchSynchronized: boolean;
  architectureSynchronized: boolean;
  generations: RepositoryGenerations;
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
  freshnessMode: "authoritative" | "watch_cache";
  authoritativeCheckedAt: string;
  reconciliationMaxAgeMs: number;
  cacheInvalidated: boolean;
}

const fastIgnoreRules = new Map<string, IgnoreRules>();
const FAST_RECONCILIATION_INTERVAL_MS = 30_000;

interface FastStatusEntry {
  status: StatusResult;
  checkedAt: number;
  dirty: boolean;
  watchers: FSWatcher[];
  worktree: WorktreeSignature;
}

const fastStatusEntries = new Map<string, FastStatusEntry>();
const fastRootByStartPath = new Map<string, string>();

function monitorShouldIgnore(filename: string | Buffer | null): boolean {
  if (filename === null) return false;
  const normalized = String(filename).replaceAll("\\", "/");
  if (!normalized.startsWith(".codeatlas/")) return false;
  return !normalized.endsWith("/config.json") && normalized !== ".codeatlas/config.json";
}

function createWatchers(
  repositoryRoot: string,
  gitAvailable: boolean,
  entry: FastStatusEntry,
): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  const markDirty = (_event: string, filename: string | Buffer | null): void => {
    if (!monitorShouldIgnore(filename)) entry.dirty = true;
  };
  try {
    const watcher = watch(repositoryRoot, { recursive: true }, markDirty);
    watcher.on("error", () => {
      entry.dirty = true;
    });
    watcher.unref();
    watchers.push(watcher);
    return watchers;
  } catch {
    // Linux may not provide recursive fs.watch. Periodic reconciliation remains authoritative.
  }
  const targets = gitAvailable ? [repositoryRoot, path.join(repositoryRoot, ".git")] : [repositoryRoot];
  for (const target of targets) {
    try {
      const watcher = watch(target, markDirty);
      watcher.on("error", () => {
        entry.dirty = true;
      });
      watcher.unref();
      watchers.push(watcher);
    } catch {
      entry.dirty = true;
    }
  }
  return watchers;
}

function cacheFastStatus(
  startPath: string,
  status: StatusResult,
  worktree: WorktreeSignature,
): void {
  const existing = fastStatusEntries.get(status.root);
  if (existing === undefined) {
    const entry: FastStatusEntry = {
      status,
      checkedAt: Date.now(),
      dirty: false,
      watchers: [],
      worktree,
    };
    entry.watchers = createWatchers(status.root, status.gitAvailable, entry);
    fastStatusEntries.set(status.root, entry);
  } else {
    existing.status = status;
    existing.checkedAt = Date.now();
    existing.dirty = false;
    existing.worktree = worktree;
  }
  fastRootByStartPath.set(path.resolve(startPath), status.root);
  if (fastStatusEntries.size > 32) {
    const oldestRoot = [...fastStatusEntries.keys()].find((root) => root !== status.root);
    if (oldestRoot !== undefined) clearFastStatusCache(oldestRoot);
  }
}

export function getFastIndexInputs(repositoryRoot: string): {
  ignoreRules: IgnoreRules;
  worktree: WorktreeSignature;
} | null {
  const entry = fastStatusEntries.get(repositoryRoot);
  const ignoreRules = fastIgnoreRules.get(repositoryRoot);
  return entry === undefined || ignoreRules === undefined
    ? null
    : { ignoreRules, worktree: entry.worktree };
}

export function clearFastStatusCache(repositoryRoot: string): void {
  fastIgnoreRules.delete(repositoryRoot);
  const entry = fastStatusEntries.get(repositoryRoot);
  for (const watcher of entry?.watchers ?? []) watcher.close();
  fastStatusEntries.delete(repositoryRoot);
  for (const [startPath, root] of fastRootByStartPath) {
    if (root === repositoryRoot) fastRootByStartPath.delete(startPath);
  }
}

function readStoredStatus(
  database: AtlasDatabase,
  repository: RepositoryInfo,
  config: CodeAtlasConfig,
  state: Readonly<Record<string, string>>,
  currentFingerprint: string,
  dirty: boolean,
  freshnessMatches: boolean,
): StatusResult {
  const baseCounts = database
    .prepare(
      `SELECT
        (SELECT count(*) FROM files) AS files,
        (SELECT count(*) FROM nodes) AS nodes,
        (SELECT count(*) FROM nodes
          WHERE kind NOT IN (
            'repository', 'package', 'directory', 'file', 'module', 'feature', 'domain',
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
  const architectureCounts = state.schema_version === String(SCHEMA_VERSION)
    ? database
        .prepare(
          `SELECT
             (SELECT count(DISTINCT community_id) FROM dependency_communities) AS communities,
             (SELECT count(*) FROM architecture_findings
                WHERE finding_type = 'circular_dependency') AS cycles,
             (SELECT count(*) FROM architecture_findings
                WHERE finding_type = 'change_hotspot') AS hotspots,
             (SELECT count(*) FROM architecture_findings) AS findings`,
        )
        .get() as { communities: number; cycles: number; hotspots: number; findings: number }
    : { communities: 0, cycles: 0, hotspots: 0, findings: 0 };
  const indexedFingerprint = state.dirty_fingerprint ?? null;
  const parserContractMatches =
    (database
      .prepare(
        `SELECT count(*) FROM files
         WHERE parser_version NOT IN ('none', ?)`,
      )
      .pluck()
      .get(TREE_SITTER_VERSION) as number) === 0;
  const contractMatches = state.indexer_version === INDEXER_VERSION &&
    state.schema_version === String(SCHEMA_VERSION) &&
    state.config_hash === sha256(JSON.stringify(config)) &&
    parserContractMatches;
  const generations = generationsFromState(state);
  const structuralSynchronized =
    freshnessMatches &&
    contractMatches &&
    generations.structural > 0 &&
    state.structural_status !== "stale";
  const semanticSynchronized =
    structuralSynchronized &&
    (state.semantic_status === "current" ||
      (state.semantic_status === undefined && generations.semantic === generations.structural));
  const searchSynchronized =
    structuralSynchronized &&
    (state.search_status === "current" ||
      (state.search_status === undefined && generations.search === generations.structural));
  const architectureSynchronized =
    structuralSynchronized &&
    (state.architecture_status === "current" ||
      (state.architecture_status === undefined && generations.architecture === generations.structural));
  return {
    repository: repository.name,
    root: repository.root,
    gitAvailable: repository.gitAvailable,
    branch: repository.branch,
    headCommit: repository.headCommit,
    indexedCommit: state.last_indexed_commit ?? null,
    synchronized:
      structuralSynchronized &&
      semanticSynchronized &&
      searchSynchronized &&
      architectureSynchronized,
    structuralSynchronized,
    semanticSynchronized,
    searchSynchronized,
    architectureSynchronized,
    generations,
    dirty,
    ...baseCounts,
    ...architectureCounts,
    lastIndexedAt: state.last_indexed_at ?? null,
    currentFingerprint,
    indexedFingerprint,
    freshnessMode: "authoritative",
    authoritativeCheckedAt: new Date().toISOString(),
    reconciliationMaxAgeMs: FAST_RECONCILIATION_INTERVAL_MS,
    cacheInvalidated: false,
  };
}

async function initializedRepository(startPath: string): Promise<RepositoryInfo> {
  const repository = await detectRepository(startPath);
  if (!(await workspaceExists(repository.root))) {
    throw new CodeAtlasError("Error: CodeAtlas is not initialized. Run `codeatlas init` first.");
  }
  return repository;
}

/** Fast status path: Git supplies changed paths and only those paths are hashed. */
export async function getFastStatus(
  startPath = process.cwd(),
  options: { forceReconcile?: boolean } = {},
): Promise<StatusResult> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const forceReconcile = options.forceReconcile === true;
  const cachedRoot = fastRootByStartPath.get(path.resolve(startPath));
  const cachedEntry = cachedRoot === undefined ? undefined : fastStatusEntries.get(cachedRoot);
  const cacheWasInvalidated = cachedEntry?.dirty === true;
  if (forceReconcile && cachedRoot !== undefined) clearFastStatusCache(cachedRoot);
  const cached = forceReconcile || cachedRoot === undefined
    ? undefined
    : cachedEntry;
  if (
    cached !== undefined &&
    !cached.dirty &&
    Date.now() - cached.checkedAt < FAST_RECONCILIATION_INTERVAL_MS
  ) {
    return {
      ...cached.status,
      freshnessMode: "watch_cache",
      cacheInvalidated: false,
    };
  }
  const repository = await initializedRepository(startPath);
  const config = await loadConfig(repository.root);
  let ignoreRules = forceReconcile
    ? undefined
    : fastIgnoreRules.get(repository.root);
  if (ignoreRules === undefined) {
    ignoreRules = await loadIgnoreRules(repository.root);
    if (!forceReconcile) fastIgnoreRules.set(repository.root, ignoreRules);
  }
  const worktree = await computeWorktreeSignature(repository, ignoreRules);
  const database = openDatabase(workspacePaths(repository.root).database, { readonly: true });
  try {
    const state = getRepositoryStates(database);
    const matches = state.worktree_signature === worktree.signature;
    const status = readStoredStatus(
      database,
      repository,
      config,
      state,
      matches ? state.dirty_fingerprint ?? worktree.signature : worktree.signature,
      repository.gitAvailable ? worktree.dirty : !matches,
      matches,
    );
    status.cacheInvalidated = cacheWasInvalidated;
    if (!forceReconcile) cacheFastStatus(startPath, status, worktree);
    return status;
  } finally {
    database.close();
  }
}

/** Full reconciliation used by the CLI and as a fallback when the fast signature changes. */
export async function getStatus(startPath = process.cwd()): Promise<StatusResult> {
  const repository = await initializedRepository(startPath);
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
  const dirty = repository.gitAvailable
    ? await isWorkingTreeDirty(repository.root)
    : state.dirty_fingerprint !== current.fingerprint;
  try {
    return readStoredStatus(
      database,
      repository,
      config,
      state,
      current.fingerprint,
      dirty,
      state.dirty_fingerprint === current.fingerprint,
    );
  } finally {
    database.close();
  }
}

export function formatStatus(result: StatusResult): string {
  return [
    `Repository: ${result.repository}`,
    result.gitAvailable ? `Branch: ${result.branch}` : "Git: unavailable (filesystem mode)",
    result.gitAvailable ? `HEAD: ${result.headCommit}` : null,
    result.gitAvailable
      ? `Working tree: ${result.dirty ? "dirty" : "clean"}`
      : `Filesystem: ${result.dirty ? "changed since index" : "matches index"}`,
    "",
    "Index:",
    `  Status: ${result.synchronized ? "up to date" : result.structuralSynchronized ? "partially current" : "out of date"}`,
    `  Structural generation: ${result.generations.structural}${result.structuralSynchronized ? " (current)" : " (stale)"}`,
    `  Semantic generation: ${result.generations.semantic}${result.semanticSynchronized ? " (current)" : " (stale)"}`,
    `  Search generation: ${result.generations.search}${result.searchSynchronized ? " (current)" : " (stale)"}`,
    `  Architecture generation: ${result.generations.architecture}${result.architectureSynchronized ? " (current)" : " (stale)"}`,
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
  ].filter((line): line is string => line !== null).join("\n");
}
