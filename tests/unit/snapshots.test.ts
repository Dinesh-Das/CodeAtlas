import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSnapshots, pruneSnapshots } from "../../src/git/snapshots.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("snapshot retention", () => {
  it("removes only the oldest complete snapshots beyond the retention limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-snapshots-"));
    roots.push(root);
    for (const [index, id] of ["old", "middle", "new"].entries()) {
      const directory = path.join(root, id);
      await mkdir(directory, { recursive: true });
      const atlasPath = path.join(directory, "atlas.json");
      await writeFile(atlasPath, "{}", "utf8");
      const date = new Date(`2026-01-0${index + 1}T00:00:00.000Z`);
      await utimes(atlasPath, date, date);
    }

    await expect(pruneSnapshots(root, 2)).resolves.toEqual(["old"]);
    await expect(listSnapshots(root)).resolves.toEqual(["middle", "new"]);
  });

  it("rejects an unsafe zero-retention request", async () => {
    await expect(pruneSnapshots("unused", 0)).rejects.toThrow("at least 1");
  });
});
