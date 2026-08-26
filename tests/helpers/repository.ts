import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface TestRepository {
  root: string;
  write(relativePath: string, content: string): Promise<void>;
  remove(): Promise<void>;
  git(...args: string[]): Promise<string>;
}

export async function createTestRepository(): Promise<TestRepository> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-test-"));
  await execFile("git", ["init", "-b", "main"], { cwd: root, windowsHide: true });
  await execFile("git", ["config", "user.name", "CodeAtlas Tests"], {
    cwd: root,
    windowsHide: true,
  });
  await execFile("git", ["config", "user.email", "codeatlas@example.invalid"], {
    cwd: root,
    windowsHide: true,
  });

  return {
    root,
    async write(relativePath: string, content: string): Promise<void> {
      const filePath = path.join(root, ...relativePath.split("/"));
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    },
    async remove(): Promise<void> {
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
    async git(...args: string[]): Promise<string> {
      const { stdout } = await execFile("git", args, {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      return stdout;
    },
  };
}
