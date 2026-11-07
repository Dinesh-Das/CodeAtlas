import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveCodexLaunch, runCodex } from "../../scripts/provider-launch.mjs";

const execFile = promisify(execFileCallback);

describe("provider process launch boundary", () => {
  it("resolves an npm installation on Windows and preserves hostile arguments without a shell", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas launch & spaces-"));
    try {
      const packageRoot = path.join(root, "node_modules", "@openai", "codex");
      const entry = path.join(packageRoot, "bin", "codex.js");
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@openai/codex", bin: { codex: "bin/codex.js" },
      }));
      await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const launch = resolveCodexLaunch({ platform: "win32", environment: { Path: root } });
      const hostile = ['spaces and "quotes"', "$(echo unsafe) & | < > %PATH% ^", "two\nlines", "नमस्ते"];

      const { stdout } = await execFile(launch.command, [...launch.prefix, ...hostile], { encoding: "utf8" });

      expect(launch.command).toBe(process.execPath);
      expect(JSON.parse(stdout)).toEqual(hostile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the provider argument builder against an offline JavaScript fixture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas provider & spaces-"));
    try {
      const entry = path.join(root, "offline cli.mjs");
      await writeFile(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
      const prompt = 'Read only; literal "quotes" & $(echo unsafe)\nDo not execute this text.';
      const schemaPath = path.join(root, "schema file.json");
      const answerPath = path.join(root, "answer file.json");

      const { stdout } = await runCodex({ workspace: root, prompt, model: "offline-model", schemaPath,
        answerPath, cliJs: entry });

      expect(JSON.parse(stdout)).toEqual([
        "exec", "--ephemeral", "--json", "--color", "never", "--sandbox", "read-only",
        "--skip-git-repo-check", "--model", "offline-model", "--output-schema", schemaPath,
        "--output-last-message", answerPath, "--cd", root, prompt,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails clearly for missing installations and refuses batch-file overrides", () => {
    expect(() => resolveCodexLaunch({ platform: "win32", environment: {} }))
      .toThrow(/JavaScript|installation/u);
    expect(() => resolveCodexLaunch({ cliJs: "unsafe.cmd" })).toThrow(/JavaScript/u);
  });
});
