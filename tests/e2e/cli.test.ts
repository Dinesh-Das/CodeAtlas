import { execFile as execFileCallback } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const execFile = promisify(execFileCallback);
const repositories: TestRepository[] = [];
const cliPath = path.resolve("dist", "cli", "index.js");

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile(process.execPath, [cliPath, ...args], {
    cwd: path.dirname(cliPath),
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("compiled CLI", () => {
  it("initializes, reports status, diagnoses, and safely cleans a Git repository", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/index.ts", "export const ready = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "fixture");

    const initialized = await runCli("init", repository.root);
    expect(initialized.stderr).toBe("");
    expect(initialized.stdout).toContain("CodeAtlas structural index is ready");

    const statusResult = await runCli("status", repository.root, "--json");
    const status = JSON.parse(statusResult.stdout) as { synchronized: boolean; files: number };
    expect(status).toMatchObject({ synchronized: true });
    expect(status.files).toBeGreaterThan(0);

    const doctor = await runCli("doctor", repository.root);
    expect(doctor.stdout).toContain("✓ SQLite: quick_check=ok, journal_mode=wal, schema=1");

    const cleaned = await runCli("clean", repository.root, "--force");
    expect(cleaned.stdout).toContain("Removed .codeatlas/");
    await expect(stat(path.join(repository.root, ".codeatlas"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
