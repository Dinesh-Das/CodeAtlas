import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig, loadConfig } from "../../src/core/config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-config-"));
  roots.push(root);
  await mkdir(path.join(root, ".codeatlas"), { recursive: true });
  return root;
}

describe("configuration", () => {
  it("creates and loads the strict default config", async () => {
    const root = await tempRoot();
    const expected = await createDefaultConfig(root);
    await expect(loadConfig(root)).resolves.toEqual(expected);
  });

  it("defaults framework analysis on for existing version 1 configurations", async () => {
    const root = await tempRoot();
    await writeFile(
      path.join(root, ".codeatlas", "config.json"),
      JSON.stringify({
        version: 1,
        languages: { typescript: true, javascript: true, python: true },
        analysis: { gitHistory: true, technicalDebt: true, featureDetection: true },
        limits: {
          maxTraversalDepth: 10,
          maxSourceSnippetLines: 120,
          maxMcpResultNodes: 200,
        },
      }),
      "utf8",
    );

    await expect(loadConfig(root)).resolves.toHaveProperty("analysis.frameworks", true);
  });

  it("fails instead of silently replacing malformed JSON", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, ".codeatlas", "config.json"), "{ nope", "utf8");
    await expect(loadConfig(root)).rejects.toThrow("config.json is invalid");
  });

  it("reports schema violations", async () => {
    const root = await tempRoot();
    await writeFile(
      path.join(root, ".codeatlas", "config.json"),
      JSON.stringify({ version: 1, languages: {}, analysis: {}, limits: "many" }),
      "utf8",
    );
    await expect(loadConfig(root)).rejects.toThrow("limits");
  });
});
