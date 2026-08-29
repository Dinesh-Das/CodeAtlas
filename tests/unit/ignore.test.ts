import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFiles } from "../../src/core/discovery.js";
import { ensureCodeAtlasIgnored, loadIgnoreRules } from "../../src/core/ignore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-ignore-"));
  roots.push(root);
  return root;
}

async function write(root: string, relativePath: string, content = "x"): Promise<void> {
  const filePath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

describe("ignore handling", () => {
  it("combines Git, CodeAtlas, generated, and secret exclusions", async () => {
    const root = await createRoot();
    await write(root, ".gitignore", "ignored-by-git/\n");
    await write(root, ".codeatlasignore", "fixtures/\n");
    await write(root, "src/index.ts");
    await write(root, "src/.gitignore", "generated/\n");
    await write(root, "src/generated/types.ts");
    await write(root, "ignored-by-git/file.ts");
    await write(root, "fixtures/sample.py");
    await write(root, "node_modules/pkg/index.js");
    await write(root, ".env.production", "TOKEN=secret");
    await write(root, "certificates/client.pem", "secret");

    const files = await discoverFiles(root, await loadIgnoreRules(root));
    expect(files.map((file) => file.relativePath)).toEqual([
      ".codeatlasignore",
      ".gitignore",
      "src/.gitignore",
      "src/index.ts",
    ]);
  });

  it("adds the workspace ignore to the local Git exclude exactly once", async () => {
    const root = await createRoot();
    await write(root, ".gitignore", "dist/");
    await import("node:child_process").then(({ execFile }) =>
      new Promise<void>((resolve, reject) => {
        execFile("git", ["init"], { cwd: root }, (error) => error ? reject(error) : resolve());
      }),
    );
    await expect(ensureCodeAtlasIgnored(root)).resolves.toBe(true);
    await expect(ensureCodeAtlasIgnored(root)).resolves.toBe(false);
    const gitignore = await import("node:fs/promises").then(({ readFile }) =>
      readFile(path.join(root, ".gitignore"), "utf8"),
    );
    const exclude = await import("node:fs/promises").then(({ readFile }) =>
      readFile(path.join(root, ".git", "info", "exclude"), "utf8"),
    );
    expect(gitignore).toBe("dist/");
    expect(exclude).toContain(".codeatlas/\n");
  });

  it("only edits .gitignore when shared mode is explicit", async () => {
    const root = await createRoot();
    await write(root, ".gitignore", "dist/");
    await expect(ensureCodeAtlasIgnored(root, true)).resolves.toBe(true);
    const content = await import("node:fs/promises").then(({ readFile }) =>
      readFile(path.join(root, ".gitignore"), "utf8"),
    );
    expect(content).toBe("dist/\n.codeatlas/\n");
  });
});
