import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import BetterSqlite3 from "better-sqlite3";
import { CodeAtlasError } from "./errors.js";
import { isPathInside } from "./paths.js";

export interface WorkspacePaths {
  root: string;
  directory: string;
  database: string;
  config: string;
  manifest: string;
  state: string;
  logs: string;
  lock: string;
  current: string;
  snapshots: string;
  cache: string;
  agent: string;
}

export function workspacePaths(repositoryRoot: string): WorkspacePaths {
  const root = path.resolve(repositoryRoot);
  const directory = path.join(root, ".codeatlas");
  return {
    root,
    directory,
    database: path.join(directory, "atlas.db"),
    config: path.join(directory, "config.json"),
    manifest: path.join(directory, "manifest.json"),
    state: path.join(directory, "state.json"),
    logs: path.join(directory, "logs"),
    lock: path.join(directory, "index.lock.db"),
    current: path.join(directory, "current"),
    snapshots: path.join(directory, "snapshots"),
    cache: path.join(directory, "cache"),
    agent: path.join(directory, "agent"),
  };
}

export async function ensureWorkspaceDirectories(repositoryRoot: string): Promise<WorkspacePaths> {
  const paths = workspacePaths(repositoryRoot);
  await Promise.all([
    mkdir(paths.logs, { recursive: true }),
    mkdir(paths.current, { recursive: true }),
    mkdir(paths.snapshots, { recursive: true }),
    mkdir(paths.cache, { recursive: true }),
    mkdir(paths.agent, { recursive: true }),
  ]);
  return paths;
}

export async function workspaceExists(repositoryRoot: string): Promise<boolean> {
  try {
    return (await stat(workspacePaths(repositoryRoot).directory)).isDirectory();
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(temporaryPath, value, "utf8");
  await rename(temporaryPath, filePath);
}

interface LockContents {
  pid: number;
  acquiredAt: string;
  token: string;
}

export interface IndexLockWait {
  elapsedMs: number;
  ownerPid: number;
  acquiredAt: string | null;
}

export interface IndexLockOptions {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  onWait?: (wait: IndexLockWait) => void;
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

async function readLockOwner(filePath: string): Promise<Partial<LockContents>> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Partial<LockContents>;
  } catch {
    return {};
  }
}

export async function acquireIndexLock(
  repositoryRoot: string,
  options: IndexLockOptions = {},
): Promise<() => Promise<void>> {
  const paths = await ensureWorkspaceDirectories(repositoryRoot);
  const waitTimeoutMs = options.waitTimeoutMs ?? 60_000;
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 500);
  const startedAt = Date.now();
  const token = randomUUID();
  const ownerPath = `${paths.lock}.owner.json`;

  while (true) {
    let candidate: BetterSqlite3.Database | null = null;
    try {
      candidate = new BetterSqlite3(paths.lock);
      candidate.pragma("busy_timeout = 0");
      candidate.exec("BEGIN EXCLUSIVE");
      const contents: LockContents = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token,
      };
      await writeJsonAtomic(ownerPath, contents);
      const ownedDatabase = candidate;
      candidate = null;

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const current = await readLockOwner(ownerPath);
          if (current.token === token) await unlink(ownerPath);
        } catch {
          // Owner metadata is diagnostic only; SQLite retains authoritative ownership.
        } finally {
          try {
            ownedDatabase.exec("ROLLBACK");
          } finally {
            ownedDatabase.close();
          }
        }
      };
    } catch (error) {
      try {
        candidate?.close();
      } catch {
        // Preserve the original acquisition error.
      }
      if (!isSqliteBusy(error)) throw error;

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= waitTimeoutMs) {
        throw new CodeAtlasError(
          `Error: another CodeAtlas indexing process did not complete within ${Math.ceil(waitTimeoutMs / 1_000)} seconds.`,
          { cause: error },
        );
      }
      const contents = await readLockOwner(ownerPath);
      options.onWait?.({
        elapsedMs,
        ownerPid: typeof contents.pid === "number" ? contents.pid : -1,
        acquiredAt: typeof contents.acquiredAt === "string" ? contents.acquiredAt : null,
      });
      await delay(Math.min(pollIntervalMs, waitTimeoutMs - elapsedMs));
    }
  }
}

export async function removeWorkspace(repositoryRoot: string): Promise<void> {
  const paths = workspacePaths(repositoryRoot);
  if (!isPathInside(paths.root, paths.directory) || path.basename(paths.directory) !== ".codeatlas") {
    throw new CodeAtlasError("Refusing to remove an invalid CodeAtlas workspace path.");
  }
  await rm(paths.directory, { recursive: true, force: true });
}
