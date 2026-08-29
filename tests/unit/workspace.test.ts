import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireIndexLock, workspacePaths } from "../../src/core/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function lockFixture(): Promise<{ root: string; lock: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-lock-"));
  roots.push(root);
  const lock = workspacePaths(root).lock;
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(
    lock,
    `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token: "owner" })}\n`,
    "utf8",
  );
  return { root, lock };
}

describe("index lock", () => {
  it("waits for a live owner and continues after release", async () => {
    const { root, lock } = await lockFixture();
    const waits: number[] = [];
    const releaseOwner = setTimeout(() => void unlink(lock).catch(() => undefined), 40);
    const release = await acquireIndexLock(root, {
      waitTimeoutMs: 500,
      pollIntervalMs: 10,
      onWait: (wait) => waits.push(wait.ownerPid),
    });
    clearTimeout(releaseOwner);
    expect(waits).toContain(process.pid);
    await expect(stat(lock)).resolves.toBeDefined();
    await release();
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails after the bounded wait expires", async () => {
    const { root } = await lockFixture();
    await expect(acquireIndexLock(root, {
      waitTimeoutMs: 30,
      pollIntervalMs: 5,
    })).rejects.toThrow("did not complete within 1 seconds");
  });
});
