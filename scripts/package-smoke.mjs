import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const packageMetadata = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codeatlas-package-"));

function progress(message) {
  process.stdout.write(`→ ${message}\n`);
}

async function run(command, args, cwd) {
  return execFile(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (npmCli !== undefined && npmCli.length > 0) {
    return run(process.execPath, [npmCli, ...args], cwd);
  }
  return run("npm", args, cwd);
}

try {
  progress("Packing the publishable artifact");
  const { stdout: packedOutput } = await runNpm(
    ["pack", "--json", "--silent", "--pack-destination", temporaryRoot],
    repositoryRoot,
  );
  const packed = JSON.parse(packedOutput);
  const packageResult = packed[0];
  if (packageResult === undefined) throw new Error("npm pack did not return a package result.");

  const paths = new Set(packageResult.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CHANGELOG.md",
    "dist/cli/index.js",
    "dist/api.js",
    "dist/api.d.ts",
    "examples/mcp-config.json",
    "examples/README.md",
  ]) {
    if (!paths.has(required)) throw new Error(`Packed package is missing ${required}.`);
  }
  for (const forbidden of [
    "src/",
    "tests/",
    "Requirements_",
    "dist/mcp/packet.",
    "RELEASING.md",
    "CODE_OF_CONDUCT.md",
    "ROADMAP.md",
  ]) {
    if ([...paths].some((filePath) => filePath.startsWith(forbidden))) {
      throw new Error(`Packed package contains forbidden or stale path prefix ${forbidden}.`);
    }
  }

  const fixtureRoot = path.join(temporaryRoot, "consumer");
  await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ name: "codeatlas-package-smoke", private: true }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(fixtureRoot, "src", "checkout.ts"),
    "export function checkout(): boolean { return true; }\n",
    "utf8",
  );
  await run("git", ["init", "-b", "main"], fixtureRoot);
  await run("git", ["config", "user.name", "CodeAtlas Package Smoke"], fixtureRoot);
  await run("git", ["config", "user.email", "codeatlas@example.invalid"], fixtureRoot);
  await run("git", ["add", "."], fixtureRoot);
  await run("git", ["commit", "-m", "package smoke fixture"], fixtureRoot);

  const tarballPath = path.join(temporaryRoot, packageResult.filename);
  progress("Installing the tarball in a disposable consumer");
  await runNpm([
    "install",
    "--save-dev",
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
    tarballPath,
  ], fixtureRoot);
  const execute = (...args) =>
    runNpm(
      ["exec", "--yes=false", "--", "codeatlas", ...args],
      fixtureRoot,
    );
  progress("Running the installed CLI");
  const { stdout: apiOutput } = await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import('@dinesh-das/codeatlas').then(api => process.stdout.write(String(typeof api.buildRepository)))",
    ],
    fixtureRoot,
  );
  if (apiOutput !== "function") throw new Error("Installed package did not expose the public API.");
  const { stdout: versionOutput } = await execute("--version");
  if (versionOutput.trim() !== packageMetadata.version) {
    throw new Error(
      `Installed CLI reported ${versionOutput.trim()} instead of ${packageMetadata.version}.`,
    );
  }

  await execute("init", fixtureRoot);
  const { stdout: statusOutput } = await execute("status", "--json", fixtureRoot);
  const status = JSON.parse(statusOutput);
  if (status.synchronized !== true || status.symbols < 1) {
    throw new Error("Installed CLI did not create a synchronized structural index.");
  }
  const localExclude = await readFile(path.join(fixtureRoot, ".git", "info", "exclude"), "utf8");
  if (!localExclude.split(/\r?\n/u).includes(".codeatlas/")) {
    throw new Error("Installed CLI did not exclude .codeatlas/ through Git info/exclude.");
  }
  const { stdout: trackedIgnoreStatus } = await run(
    "git",
    ["status", "--short", "--", ".gitignore"],
    fixtureRoot,
  );
  if (trackedIgnoreStatus.trim() !== "") {
    throw new Error("Installed CLI unexpectedly modified the repository .gitignore.");
  }
  const { stdout: overviewOutput } = await execute("overview", fixtureRoot);
  if (!overviewOutput.includes("Ask your coding agent")) {
    throw new Error("Installed CLI did not produce the direct architecture overview.");
  }
  const { stdout: answerOutput } = await execute(
    "ask",
    "Explain the repository architecture and where an AI coding agent should start.",
    fixtureRoot,
    "--json",
  );
  const answer = JSON.parse(answerOutput);
  if (
    !answer.answer.includes("Start with") ||
    !Array.isArray(answer.claims) ||
    answer.claims.length === 0 ||
    !Array.isArray(answer.evidence) ||
    answer.evidence.length === 0 ||
    answer.evidence.some((item) => /(?:^|\/)(?:tests?|fixtures?|examples?|scripts?)(?:\/|$)/iu.test(item.file))
  ) {
    throw new Error("Installed CLI did not produce a relevant, production-scoped architecture answer.");
  }
  await execute("setup", "--all", "--dry-run", fixtureRoot);

  process.stdout.write(
    `✓ Packed ${packageResult.filename} (${packageResult.entryCount} files)\n` +
      `✓ Installed ${packageMetadata.name} and ran codeatlas ${packageMetadata.version}\n` +
      "✓ Initialized and queried a disposable Git repository\n",
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
}
