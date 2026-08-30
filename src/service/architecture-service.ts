import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildRepository } from "../compiler/build.js";
import { getFastStatus, type StatusResult } from "../cli/status.js";
import { workspaceExists, workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import type { Atlas } from "../ir/models.js";
import { assertValidAtlas } from "../ir/validation.js";
import { loadV2Config, v2ConfigFingerprint } from "../rules/config.js";
import type { RepositoryGenerations } from "../storage/state.js";
import { CODEATLAS_VERSION, INDEXER_VERSION } from "../version.js";
import { ensureFreshIndex } from "./freshness.js";

interface CurrentBuildMetadata {
  snapshot_id?: string;
  current_fingerprint?: string;
  generations?: RepositoryGenerations;
  v2_config_fingerprint?: string;
  git_base?: string;
  git_head?: string;
}

interface CachedArchitecture {
  key: string;
  atlas: Atlas;
  status: StatusResult;
}

export interface ArchitectureContext {
  repositoryRoot: string;
  atlas: Atlas;
  status: StatusResult;
  fingerprint: string;
  cacheHit: boolean;
  rebuilt: boolean;
}

function expectedSnapshotId(status: StatusResult): string {
  return status.dirty || status.headCommit === "unborn"
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

async function readReusableAtlas(
  repositoryRoot: string,
  status: StatusResult,
  configFingerprint: string,
): Promise<Atlas | null> {
  const current = workspacePaths(repositoryRoot).current;
  try {
    const [atlasText, buildText] = await Promise.all([
      readFile(path.join(current, "atlas.json"), "utf8"),
      readFile(path.join(current, "build.json"), "utf8"),
    ]);
    const atlas = JSON.parse(atlasText) as Atlas;
    const build = JSON.parse(buildText) as CurrentBuildMetadata;
    assertValidAtlas(atlas);
    const expectedSnapshot = expectedSnapshotId(status);
    if (
      atlas.snapshot.id !== expectedSnapshot ||
      atlas.generator.version !== CODEATLAS_VERSION ||
      atlas.generator.indexer_version !== INDEXER_VERSION ||
      build.snapshot_id !== expectedSnapshot ||
      build.current_fingerprint !== status.currentFingerprint ||
      !sameGenerations(build.generations, status.generations) ||
      build.v2_config_fingerprint !== configFingerprint ||
      build.git_base !== status.headCommit ||
      build.git_head !== status.headCommit
    ) {
      return null;
    }
    return atlas;
  } catch {
    return null;
  }
}

async function readBuiltAtlas(currentDirectory: string): Promise<Atlas> {
  const atlas = JSON.parse(await readFile(path.join(currentDirectory, "atlas.json"), "utf8")) as Atlas;
  assertValidAtlas(atlas);
  return atlas;
}

export class ArchitectureService {
  private readonly cache = new Map<string, CachedArchitecture>();
  private readonly activeLoads = new Map<string, Promise<ArchitectureContext>>();

  clear(repositoryRoot?: string): void {
    if (repositoryRoot === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(path.resolve(repositoryRoot));
  }

  async load(startPath = process.cwd()): Promise<ArchitectureContext> {
    const repository = await detectRepository(startPath);
    let status: StatusResult;
    let initializedByBuild = false;
    if (await workspaceExists(repository.root)) {
      status = (await ensureFreshIndex(repository.root, "architecture")).status;
    } else {
      await buildRepository(repository.root, { snapshot: false });
      initializedByBuild = true;
      status = await getFastStatus(repository.root, { forceReconcile: true });
    }

    const configFingerprint = v2ConfigFingerprint(await loadV2Config(repository.root));
    const key = cacheKey(status, configFingerprint);
    const cached = this.cache.get(repository.root);
    if (cached?.key === key) {
      cached.status = status;
      return {
        repositoryRoot: repository.root,
        atlas: cached.atlas,
        status,
        fingerprint: status.currentFingerprint,
        cacheHit: true,
        rebuilt: false,
      };
    }

    const activeKey = `${repository.root}\0${key}`;
    const active = this.activeLoads.get(activeKey);
    if (active !== undefined) return active;

    const load = (async (): Promise<ArchitectureContext> => {
      let atlas = await readReusableAtlas(repository.root, status, configFingerprint);
      let rebuilt = initializedByBuild;
      if (atlas === null) {
        const build = await buildRepository(repository.root, { snapshot: false });
        atlas = await readBuiltAtlas(build.currentDirectory);
        rebuilt = true;
      }
      this.cache.set(repository.root, { key, atlas, status });
      return {
        repositoryRoot: repository.root,
        atlas,
        status,
        fingerprint: status.currentFingerprint,
        cacheHit: false,
        rebuilt,
      };
    })();
    this.activeLoads.set(activeKey, load);
    try {
      return await load;
    } finally {
      if (this.activeLoads.get(activeKey) === load) this.activeLoads.delete(activeKey);
    }
  }
}

export const architectureService = new ArchitectureService();
