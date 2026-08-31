import { mkdtemp, rm, stat } from "node:fs/promises";
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
  return { root, lock };
}

describe("index lock", () => {
  it("waits for a live owner and continues after release", async () => {
    const { root, lock } = await lockFixture();
    const releaseOwner = await acquireIndexLock(root);
    const waits: number[] = [];
    const releaseTimer = setTimeout(() => void releaseOwner(), 40);
    const release = await acquireIndexLock(root, {
      waitTimeoutMs: 500,
      pollIntervalMs: 10,
      onWait: (wait) => waits.push(wait.ownerPid),
    });
    clearTimeout(releaseTimer);
    expect(waits).toContain(process.pid);
    await expect(stat(lock)).resolves.toBeDefined();
    await release();
    await expect(stat(lock)).resolves.toBeDefined();
  });

  it("fails after the bounded wait expires", async () => {
    const { root } = await lockFixture();
    const releaseOwner = await acquireIndexLock(root);
    try {
      await expect(acquireIndexLock(root, {
        waitTimeoutMs: 30,
        pollIntervalMs: 5,
      })).rejects.toThrow("did not complete within 1 seconds");
    } finally {
      await releaseOwner();
    }
  });

  it("serializes concurrent contenders without overlapping ownership", async () => {
    const { root } = await lockFixture();
    let active = 0;
    let maximumActive = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      const release = await acquireIndexLock(root, {
        waitTimeoutMs: 10_000,
        pollIntervalMs: 10,
      });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      await release();
    }));
    expect(maximumActive).toBe(1);
  });
});
