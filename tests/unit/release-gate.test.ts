import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFile = promisify(execFileCallback);

it("blocks prerelease artifact drift while allowing incomplete stable evaluation evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-release-gate-"));
  try {
    for (const file of [
      ".github/workflows/release.yml", ".github/workflows/ci.yml",
      ".github/workflows/codeql.yml", ".github/workflows/release-evidence.yml",
      "scripts/release-gate.mjs",
    ]) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.resolve(file)));
    }
    const version = "1.0.0-beta.1";
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", version }));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      version, packages: { "": { version } },
    }));
    await writeFile(path.join(root, "src/version.ts"), `export const CODEATLAS_VERSION = "${version}";`);
    await writeFile(path.join(root, "CHANGELOG.md"), `## ${version} - 2026-10-21`);
    const evidence = JSON.parse(await readFile("release-evidence.json", "utf8"));
    evidence.targetVersion = "1.0.0";
    evidence.releaseArtifact = {
      codeAtlasVersion: version,
      packageSha256: "a".repeat(64),
      packedFileCount: 500,
    };
    evidence.providerEvaluation = null;
    const evidencePath = path.join(root, "release-evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence));
    await writeFile(path.join(root, "scripts/package-fingerprint.mjs"),
      'export async function createPackageFingerprint() { return { packageSha256: "a".repeat(64), packedFileCount: 500 }; }');
    await mkdir(path.join(root, "dist/release"), { recursive: true });
    await writeFile(path.join(root, "dist/release/evidence.js"),
      'const evidence = await import(process.env.CODEATLAS_TEST_EVIDENCE_MODULE);\n' +
      'export const validateReleaseArtifact = evidence.validateReleaseArtifact;\n' +
      'export const validateStableReleaseEvidence = evidence.validateStableReleaseEvidence;\n');

    const run = (...args: string[]) => execFile(process.execPath, ["scripts/release-gate.mjs", ...args], {
      cwd: root, windowsHide: true, timeout: 10_000,
      env: {
        ...process.env,
        CODEATLAS_TEST_EVIDENCE_MODULE: pathToFileURL(path.resolve("dist/release/evidence.js")).href,
      },
    });
    expect((await run()).stdout).toContain("Prerelease gate passed");
    await expect(run("--stable")).rejects.toMatchObject({
      stderr: expect.stringContaining("paired held-out provider evaluation is required"),
    });

    evidence.releaseArtifact.packageSha256 = "b".repeat(64);
    await writeFile(evidencePath, JSON.stringify(evidence));
    await expect(run()).rejects.toMatchObject({
      stderr: expect.stringContaining("SHA-256 does not match"),
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
