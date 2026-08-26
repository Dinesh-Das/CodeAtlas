import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
    lock: path.join(directory, "lock"),
  };
}

export async function ensureWorkspaceDirectories(repositoryRoot: string): Promise<WorkspacePaths> {
  const paths = workspacePaths(repositoryRoot);
  await mkdir(paths.logs, { recursive: true });
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
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

interface LockContents {
  pid: number;
  acquiredAt: string;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireIndexLock(repositoryRoot: string): Promise<() => Promise<void>> {
  const paths = await ensureWorkspaceDirectories(repositoryRoot);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(paths.lock, "wx");
      const contents: LockContents = { pid: process.pid, acquiredAt: new Date().toISOString() };
      await handle.writeFile(`${JSON.stringify(contents)}\n`, "utf8");
      await handle.close();

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(paths.lock).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      let stale = false;
      try {
        const contents = JSON.parse(await readFile(paths.lock, "utf8")) as Partial<LockContents>;
        stale = typeof contents.pid !== "number" || !isProcessRunning(contents.pid);
      } catch {
        stale = true;
      }

      if (!stale || attempt === 1) {
        throw new CodeAtlasError(
          "Error: another CodeAtlas indexing process is active for this repository.",
          { cause: error },
        );
      }

      await unlink(paths.lock).catch(() => undefined);
    }
  }

  throw new CodeAtlasError("Error: could not acquire the CodeAtlas index lock.");
}

export async function removeWorkspace(repositoryRoot: string): Promise<void> {
  const paths = workspacePaths(repositoryRoot);
  if (!isPathInside(paths.root, paths.directory) || path.basename(paths.directory) !== ".codeatlas") {
    throw new CodeAtlasError("Refusing to remove an invalid CodeAtlas workspace path.");
  }
  await rm(paths.directory, { recursive: true, force: true });
}
