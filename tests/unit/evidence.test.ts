import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceExcerptReader } from "../../src/ir/evidence.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evidence excerpt boundaries", () => {
  it("rejects symlinks and junctions that resolve outside the repository", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "codeatlas-evidence-"));
    roots.push(fixture);
    const repositoryRoot = path.join(fixture, "repository");
    const outsideRoot = path.join(fixture, "outside");
    await Promise.all([mkdir(repositoryRoot), mkdir(outsideRoot)]);
    await writeFile(path.join(outsideRoot, "secret.txt"), "outside repository\n", "utf8");
    await symlink(
      outsideRoot,
      path.join(repositoryRoot, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      new EvidenceExcerptReader(repositoryRoot).excerpt("escape/secret.txt", 1, 1),
    ).resolves.toBeNull();
  });

  it("allows symlinks and junctions whose targets remain inside the repository", async () => {
    const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "codeatlas-evidence-"));
    roots.push(repositoryRoot);
    const sourceRoot = path.join(repositoryRoot, "source");
    await mkdir(sourceRoot);
    await writeFile(path.join(sourceRoot, "value.ts"), "export const value = 1;\n", "utf8");
    await symlink(
      sourceRoot,
      path.join(repositoryRoot, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      new EvidenceExcerptReader(repositoryRoot).excerpt("alias/value.ts", 1, 1),
    ).resolves.toBe("export const value = 1;");
  });
});
