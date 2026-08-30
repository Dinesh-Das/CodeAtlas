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
  it("exposes the complete v2 command surface through Commander", async () => {
    const help = await runCli("--help");
    for (const command of [
      "build", "update", "watch", "search", "symbol", "impact", "diff", "check", "review", "ask", "snapshot", "mcp",
    ]) {
      expect(help.stdout).toMatch(new RegExp(`\\b${command}\\b`, "u"));
    }
    const snapshotHelp = await runCli("snapshot", "--help");
    expect(snapshotHelp.stdout).toMatch(/\blist\b/u);
    expect(snapshotHelp.stdout).toMatch(/\bshow\b/u);
    expect(snapshotHelp.stdout).toMatch(/\bdiff\b/u);
  });

  it("initializes, reports status, diagnoses, and safely cleans a Git repository", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/index.ts", "export const ready = true;\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "fixture");

    const initialized = await runCli("init", repository.root);
    expect(initialized.stderr).toContain("Building codebase map...");
    expect(initialized.stderr).toContain("repository discovery");
    expect(initialized.stderr).toContain("tree sitter parsing");
    expect(initialized.stdout).toContain("CodeAtlas is ready");
    expect(initialized.stdout).toContain("codeatlas mcp");

    const statusResult = await runCli("status", repository.root, "--json");
    const status = JSON.parse(statusResult.stdout) as { synchronized: boolean; files: number };
    expect(status).toMatchObject({ synchronized: true });
    expect(status.files).toBeGreaterThan(0);

    await repository.write("src/index.ts", "export const ready = 'updated';\n");
    const jsonIndexResult = await runCli("index", repository.root, "--json");
    expect(jsonIndexResult.stderr).toBe("");
    expect(JSON.parse(jsonIndexResult.stdout)).toMatchObject({
      changedFiles: 1,
      fullRebuild: false,
      semanticChanges: { public_contract_change: 1 },
      generations: {
        structural: 2,
        semantic: 2,
        search: 1,
        architecture: 2,
      },
      phaseMetrics: expect.arrayContaining([
        expect.objectContaining({ phase: "tree_sitter_parsing" }),
        expect.objectContaining({ phase: "architecture_domain_feature_analysis" }),
      ]),
    });

    await repository.write("src/index.ts", "export const ready = 'quiet';\n");
    const quietIndexResult = await runCli("index", repository.root, "--quiet");
    expect(quietIndexResult).toEqual({ stdout: "", stderr: "" });

    const doctor = await runCli("doctor", repository.root);
    expect(doctor.stdout).toContain("[OK] SQLite: quick_check=ok, journal_mode=wal, schema=10");
    expect(doctor.stdout).toContain("[OK] Graph integrity:");
    expect(doctor.stdout).toContain("[OK] Relationship quality:");
    expect(doctor.stdout).toContain("[OK] Database storage:");
    expect(doctor.stdout).toContain("[OK] Stale files:");

    const cleaned = await runCli("clean", repository.root, "--force");
    expect(cleaned.stdout).toContain("Removed .codeatlas/");
    await expect(stat(path.join(repository.root, ".codeatlas"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  it("diffs an arbitrary head without changing the checked-out commit", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/index.ts", "export function value(): number { return 1; }\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "base");
    const base = (await repository.git("rev-parse", "HEAD")).trim();
    await repository.write("src/index.ts", "export function value(): number { return 2; }\nexport function added(): number { return value(); }\n");
    await repository.git("add", ".");
    await repository.git("commit", "-m", "head");
    const head = (await repository.git("rev-parse", "HEAD")).trim();
    await repository.git("checkout", "--detach", base);

    const diffResult = await runCli("diff", repository.root, "--base", base, "--head", head, "--json");
    const diff = JSON.parse(diffResult.stdout) as {
      changes: Array<{ symbol_changes: Array<{ status: string; qualified_name: string | null }> }>;
      changedSymbols: string[];
    };
    expect(diff.changedSymbols.length).toBeGreaterThan(0);
    expect(diff.changes.flatMap((change) => change.symbol_changes)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "MODIFIED", qualified_name: "value" }),
      expect.objectContaining({ status: "ADDED", qualified_name: "added" }),
    ]));

    expect((await repository.git("rev-parse", "HEAD")).trim()).toBe(base);
  }, 90_000);

  it("returns a non-zero exit code for blocking architecture rules", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await repository.write("src/index.ts", "export const ready = true;\n");
    await repository.write(".codeatlas.yml", [
      "version: 1",
      "architecture:",
      "  rules:",
      "    - id: no-index-source",
      "      severity: error",
      "      source:",
      "        matches_path: src/index.ts",
      "      forbid:",
      "        matches_path: src/index.ts",
      "",
    ].join("\n"));
    await repository.git("add", ".");
    await repository.git("commit", "-m", "fixture");

    await expect(runCli("check", repository.root)).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("[ERROR]"),
    });
  }, 30_000);
});
