import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildRepository } from "../compiler/build.js";
import { getFastStatus, type StatusResult } from "../cli/status.js";
import { workspaceExists, workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import type { Atlas } from "../ir/models.js";
import { EvidenceExcerptReader } from "../ir/evidence.js";
import { loadAtlasFromDatabase } from "../ir/loader.js";
import { normalizeAtlas } from "../ir/serialization.js";
import { assertValidAtlas, computeAtlasStatistics } from "../ir/validation.js";
import { loadV2Config, v2ConfigFingerprint } from "../rules/config.js";
import {
  readAtlasRuntime,
  readAtlasRuntimeManifest,
  persistAtlasRuntime,
  type AtlasRuntimeManifest,
} from "../storage/atlas-cache.js";
import type { RepositoryGenerations } from "../storage/state.js";
import { openDatabase } from "../storage/database.js";
import { SqliteQueryStore, type QueryStore } from "../storage/query-store.js";
import { CODEATLAS_VERSION, INDEXER_VERSION } from "../version.js";
import { createAtlasProjection, type AtlasProjection } from "./atlas-projection.js";
import { ensureFreshIndex } from "./freshness.js";

interface CachedArchitecture {
  key: string;
  atlas: Atlas;
  projection: AtlasProjection;
  queryStore: QueryStore;
  status: StatusResult;
}

interface CachedArchitectureQuery {
  key: string;
  manifest: AtlasRuntimeManifest;
  queryStore: QueryStore;
  status: StatusResult;
}

export interface ArchitectureLoadTimings {
  freshness: number;
  retrieval: number;
  projection: number;
  total: number;
}

export interface ArchitectureContext {
  repositoryRoot: string;
  atlas: Atlas;
  projection: AtlasProjection;
  queryStore: QueryStore;
  status: StatusResult;
  fingerprint: string;
  cacheHit: boolean;
  rebuilt: boolean;
  timingsMs: ArchitectureLoadTimings;
}

export interface ArchitectureQueryContext {
  repositoryRoot: string;
  manifest: AtlasRuntimeManifest;
  queryStore: QueryStore;
  status: StatusResult;
  fingerprint: string;
  cacheHit: boolean;
  rebuilt: boolean;
  timingsMs: ArchitectureLoadTimings;
}

function elapsed(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(3));
}

function expectedSnapshotId(status: StatusResult): string {
  return !status.gitAvailable || status.dirty || status.headCommit === "unborn"
    ? `worktree-${status.currentFingerprint.slice(0, 16)}`
    : status.headCommit;
}

function cacheKey(status: StatusResult, configFingerprint: string): string {
  const generations = status.generations;
  return [
    status.currentFingerprint,
    generations.structural,
    generations.semantic,
    generations.search,
    generations.architecture,
    configFingerprint,
    CODEATLAS_VERSION,
    INDEXER_VERSION,
  ].join(":");
}

function sameGenerations(
  left: RepositoryGenerations | undefined,
  right: RepositoryGenerations,
): boolean {
  return left !== undefined &&
    left.structural === right.structural &&
    left.semantic === right.semantic &&
    left.search === right.search &&
    left.architecture === right.architecture;
}

function reusableBuild(
  manifest: AtlasRuntimeManifest,
  status: StatusResult,
  configFingerprint: string,
): boolean {
  const expectedSnapshot = expectedSnapshotId(status);
  const expectedGitCommit = status.gitAvailable ? status.headCommit : null;
  return manifest.snapshot.id === expectedSnapshot &&
    manifest.generator.version === CODEATLAS_VERSION &&
    manifest.generator.indexer_version === INDEXER_VERSION &&
    manifest.current_fingerprint === status.currentFingerprint &&
    sameGenerations(manifest.generations, status.generations) &&
    manifest.v2_config_fingerprint === configFingerprint &&
    manifest.git_available === status.gitAvailable &&
    manifest.git_base === expectedGitCommit &&
    manifest.git_head === expectedGitCommit;
}

async function readReusableManifest(
  repositoryRoot: string,
  status: StatusResult,
  configFingerprint: string,
  requiredKind: "query" | "full",
): Promise<AtlasRuntimeManifest | null> {
  const paths = workspacePaths(repositoryRoot);
  let manifest: AtlasRuntimeManifest | null;
  try {
    manifest = readAtlasRuntimeManifest(paths.database);
  } catch {
    return null;
  }
  if (manifest === null) return null;
  if (requiredKind === "full" && manifest.runtime_kind !== "full") return null;
  return reusableBuild(manifest, status, configFingerprint) ? manifest : null;
}

async function buildQueryRuntime(
  repositoryRoot: string,
  status: StatusResult,
  configFingerprint: string,
): Promise<AtlasRuntimeManifest> {
  const repository = await detectRepository(repositoryRoot);
  const paths = workspacePaths(repositoryRoot);
  const database = openDatabase(paths.database, { readonly: true });
  let atlas: Atlas;
  try {
    atlas = await loadAtlasFromDatabase({
      database,
      repositoryRoot,
      repositoryId: repository.id,
      repositoryName: repository.name,
      gitAvailable: repository.gitAvailable,
      headCommit: repository.headCommit,
      branch: repository.branch,
    });
  } finally {
    database.close();
  }
  atlas.statistics = computeAtlasStatistics(atlas);
  atlas = normalizeAtlas(atlas);
  assertValidAtlas(atlas);
  const expectedGitCommit = status.gitAvailable ? status.headCommit : null;
  persistAtlasRuntime(paths.database, atlas, {
    kind: "query",
    currentFingerprint: status.currentFingerprint,
    generations: status.generations,
    configFingerprint,
    gitAvailable: status.gitAvailable,
    gitBase: expectedGitCommit,
    gitHead: expectedGitCommit,
  });
  const manifest = readAtlasRuntimeManifest(paths.database);
  if (manifest === null) throw new Error("The SQLite query runtime manifest was not persisted.");
  return manifest;
}

async function readBuiltAtlas(databasePath: string, repositoryRoot: string): Promise<Atlas> {
  const atlas = readAtlasRuntime(databasePath);
  if (atlas === null) throw new Error("The SQLite architecture runtime was not persisted by the build.");
  const reader = new EvidenceExcerptReader(repositoryRoot);
  atlas.evidence = await Promise.all(atlas.evidence.map(async (evidence) => {
    const excerpt = await reader.read(evidence.file, evidence.start_line, evidence.end_line);
    return { ...evidence, excerpt: excerpt.excerpt, excerpt_status: excerpt.status };
  }));
  assertValidAtlas(atlas);
  return atlas;
}

async function prepareArchitecture(startPath: string): Promise<{
  repositoryRoot: string;
  status: StatusResult;
  freshness: number;
  initializedByBuild: boolean;
  configFingerprint: string;
}> {
  const freshnessStartedAt = performance.now();
  let status: StatusResult;
  let initializedByBuild = false;
  let repositoryRoot: string;
  try {
    status = (await ensureFreshIndex(startPath, "architecture")).status;
    repositoryRoot = status.root;
  } catch (error) {
    const repository = await detectRepository(startPath);
    if (await workspaceExists(repository.root)) throw error;
    await buildRepository(repository.root, { snapshot: false, artifacts: "query" });
    initializedByBuild = true;
    status = await getFastStatus(repository.root, { forceReconcile: true });
    repositoryRoot = repository.root;
  }
  const freshness = elapsed(freshnessStartedAt);
  const configFingerprint = v2ConfigFingerprint(await loadV2Config(repositoryRoot));
  return { repositoryRoot, status, freshness, initializedByBuild, configFingerprint };
}

export class ArchitectureService {
  private readonly cache = new Map<string, CachedArchitecture>();
  private readonly queryCache = new Map<string, CachedArchitectureQuery>();
  private readonly activeLoads = new Map<string, Promise<ArchitectureContext>>();
  private readonly activeQueryLoads = new Map<string, Promise<ArchitectureQueryContext>>();

  clear(repositoryRoot?: string): void {
    if (repositoryRoot === undefined) {
      this.cache.clear();
      this.queryCache.clear();
      return;
    }
    const resolved = path.resolve(repositoryRoot);
    this.cache.delete(resolved);
    this.queryCache.delete(resolved);
  }

  async load(startPath = process.cwd()): Promise<ArchitectureContext> {
    const totalStartedAt = performance.now();
    const prepared = await prepareArchitecture(startPath);
    const { repositoryRoot, status, freshness, initializedByBuild, configFingerprint } = prepared;
    const retrievalStartedAt = performance.now();
    let retrieval = elapsed(retrievalStartedAt);
    const key = cacheKey(status, configFingerprint);
    const cached = this.cache.get(repositoryRoot);
    if (cached?.key === key) {
      cached.status = status;
      return {
        repositoryRoot,
        atlas: cached.atlas,
        projection: cached.projection,
        queryStore: cached.queryStore,
        status,
        fingerprint: status.currentFingerprint,
        cacheHit: true,
        rebuilt: false,
        timingsMs: {
          freshness,
          retrieval,
          projection: 0,
          total: elapsed(totalStartedAt),
        },
      };
    }

    const activeKey = `${repositoryRoot}\0${key}`;
    const active = this.activeLoads.get(activeKey);
    if (active !== undefined) return active;

    const load = (async (): Promise<ArchitectureContext> => {
      const atlasRetrievalStartedAt = performance.now();
      let manifest = await readReusableManifest(repositoryRoot, status, configFingerprint, "full");
      let rebuilt = initializedByBuild;
      if (manifest === null) {
        await buildRepository(repositoryRoot, { snapshot: false, artifacts: "query" });
        manifest = readAtlasRuntimeManifest(workspacePaths(repositoryRoot).database);
        rebuilt = true;
      }
      if (manifest === null) throw new Error("The SQLite architecture runtime manifest is unavailable.");
      const atlas = await readBuiltAtlas(workspacePaths(repositoryRoot).database, repositoryRoot);
      retrieval += elapsed(atlasRetrievalStartedAt);
      const projectionStartedAt = performance.now();
      const projection = createAtlasProjection(atlas);
      const projectionMs = elapsed(projectionStartedAt);
      const queryStore = new SqliteQueryStore(workspacePaths(repositoryRoot).database);
      this.cache.set(repositoryRoot, { key, atlas, projection, queryStore, status });
      this.queryCache.set(repositoryRoot, { key, manifest, queryStore, status });
      return {
        repositoryRoot,
        atlas,
        projection,
        queryStore,
        status,
        fingerprint: status.currentFingerprint,
        cacheHit: false,
        rebuilt,
        timingsMs: {
          freshness,
          retrieval,
          projection: projectionMs,
          total: elapsed(totalStartedAt),
        },
      };
    })();
    this.activeLoads.set(activeKey, load);
    try {
      return await load;
    } finally {
      if (this.activeLoads.get(activeKey) === load) this.activeLoads.delete(activeKey);
    }
  }

  async loadQuery(startPath = process.cwd()): Promise<ArchitectureQueryContext> {
    const totalStartedAt = performance.now();
    const prepared = await prepareArchitecture(startPath);
    const { repositoryRoot, status, freshness, initializedByBuild, configFingerprint } = prepared;
    const key = cacheKey(status, configFingerprint);
    const cached = this.queryCache.get(repositoryRoot);
    if (cached?.key === key) {
      cached.status = status;
      return {
        repositoryRoot,
        manifest: cached.manifest,
        queryStore: cached.queryStore,
        status,
        fingerprint: status.currentFingerprint,
        cacheHit: true,
        rebuilt: false,
        timingsMs: { freshness, retrieval: 0, projection: 0, total: elapsed(totalStartedAt) },
      };
    }

    const activeKey = `${repositoryRoot}\0${key}`;
    const active = this.activeQueryLoads.get(activeKey);
    if (active !== undefined) return active;
    const load = (async (): Promise<ArchitectureQueryContext> => {
      const retrievalStartedAt = performance.now();
      let manifest = await readReusableManifest(repositoryRoot, status, configFingerprint, "query");
      let rebuilt = initializedByBuild;
      if (manifest === null) {
        manifest = await buildQueryRuntime(repositoryRoot, status, configFingerprint);
        rebuilt = true;
      }
      if (manifest === null) throw new Error("The SQLite architecture runtime manifest is unavailable.");
      const queryStore = new SqliteQueryStore(workspacePaths(repositoryRoot).database);
      const retrieval = elapsed(retrievalStartedAt);
      this.queryCache.set(repositoryRoot, { key, manifest, queryStore, status });
      return {
        repositoryRoot,
        manifest,
        queryStore,
        status,
        fingerprint: status.currentFingerprint,
        cacheHit: false,
        rebuilt,
        timingsMs: { freshness, retrieval, projection: 0, total: elapsed(totalStartedAt) },
      };
    })();
    this.activeQueryLoads.set(activeKey, load);
    try {
      return await load;
    } finally {
      if (this.activeQueryLoads.get(activeKey) === load) this.activeQueryLoads.delete(activeKey);
    }
  }
}

export const architectureService = new ArchitectureService();
