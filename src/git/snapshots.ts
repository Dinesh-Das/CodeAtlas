import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "../core/workspace.js";
import type { Atlas } from "../ir/models.js";
import { serializeAtlas } from "../ir/serialization.js";
import { assertValidAtlas } from "../ir/validation.js";
import { compareArchitecture, type ArchitectureDiff } from "./architecture-diff.js";

function safeSnapshotId(id: string): string {
  if (id === "." || id === ".." || !/^[a-zA-Z0-9._-]+$/u.test(id)) {
    throw new Error(`Invalid snapshot ID: ${id}`);
  }
  return id;
}

export async function persistSnapshot(atlas: Atlas, snapshotsDirectory: string): Promise<string> {
  const id = safeSnapshotId(atlas.snapshot.id);
  const directory = path.join(snapshotsDirectory, id);
  await mkdir(directory, { recursive: true });
  await writeTextAtomic(path.join(directory, "atlas.json"), serializeAtlas(atlas));
  return directory;
}

export async function listSnapshots(snapshotsDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(snapshotsDirectory, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        if ((await stat(path.join(snapshotsDirectory, entry.name, "atlas.json"))).isFile()) {
          results.push(entry.name);
        }
      } catch {
        // Ignore incomplete snapshots left by interrupted older versions.
      }
    }
    return results.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function loadSnapshot(snapshotsDirectory: string, id: string): Promise<Atlas> {
  const contents = await readFile(
    path.join(snapshotsDirectory, safeSnapshotId(id), "atlas.json"),
    "utf8",
  );
  const atlas = JSON.parse(contents) as Atlas;
  assertValidAtlas(atlas);
  return atlas;
}

export async function compareSnapshots(
  snapshotsDirectory: string,
  oldId: string,
  newId: string,
): Promise<ArchitectureDiff> {
  const [oldAtlas, newAtlas] = await Promise.all([
    loadSnapshot(snapshotsDirectory, oldId),
    loadSnapshot(snapshotsDirectory, newId),
  ]);
  return compareArchitecture(oldAtlas, newAtlas);
}
