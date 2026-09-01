import { workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import { compareSnapshots, listSnapshots, loadSnapshot, pruneSnapshots } from "../git/snapshots.js";
import { loadConfig } from "../core/config.js";

export async function snapshotList(startPath = process.cwd()): Promise<string[]> {
  const repository = await detectRepository(startPath);
  return listSnapshots(workspacePaths(repository.root).snapshots);
}

export async function snapshotShow(id: string, startPath = process.cwd()) {
  const repository = await detectRepository(startPath);
  return loadSnapshot(workspacePaths(repository.root).snapshots, id);
}

export async function snapshotDiff(oldId: string, newId: string, startPath = process.cwd()) {
  const repository = await detectRepository(startPath);
  return compareSnapshots(workspacePaths(repository.root).snapshots, oldId, newId);
}

export async function snapshotPrune(keep: number | undefined, startPath = process.cwd()) {
  const repository = await detectRepository(startPath);
  const retention = keep ?? (await loadConfig(repository.root)).limits.maxSnapshots;
  return pruneSnapshots(workspacePaths(repository.root).snapshots, retention);
}
