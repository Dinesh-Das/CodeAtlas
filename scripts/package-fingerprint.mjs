import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function runNpm(arguments_, cwd) {
  const adjacentNpmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const npmCli = process.env.npm_execpath ??
    (existsSync(adjacentNpmCli) ? adjacentNpmCli : undefined);
  return npmCli
    ? execFile(process.execPath, [npmCli, ...arguments_], {
        cwd,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      })
    : execFile("npm", arguments_, {
        cwd,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      });
}

export async function createPackageFingerprint(repositoryRoot) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codeatlas-artifact-"));
  try {
    const { stdout } = await runNpm(
      ["pack", "--json", "--silent", "--pack-destination", temporaryRoot],
      repositoryRoot,
    );
    const [packed] = JSON.parse(stdout);
    if (
      typeof packed?.filename !== "string" ||
      !Number.isInteger(packed?.entryCount) ||
      packed.entryCount <= 0
    ) {
      throw new Error("npm pack did not return a valid artifact manifest.");
    }
    const tarball = await readFile(path.join(temporaryRoot, packed.filename));
    return {
      packageSha256: createHash("sha256").update(tarball).digest("hex"),
      packedFileCount: packed.entryCount,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}
