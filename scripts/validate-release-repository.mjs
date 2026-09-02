import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  repositoryValidationSchema,
  STABLE_RELEASE_BUDGETS,
} from "../dist/release/evidence.js";

const execFile = promisify(execFileCallback);
function normalizeRepositoryUrl(value) {
  const scpStyle = value.match(/^git@([^:]+):(.+)$/u);
  const candidate = scpStyle
    ? `https://${scpStyle[1]}/${scpStyle[2]}`
    : value.startsWith("ssh://git@")
      ? value.replace("ssh://git@", "https://")
      : value;
  const url = new URL(candidate);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("The target repository origin must be a credential-free HTTPS or Git SSH URL.");
  }
  return url.href.replace(/\.git\/?$/u, "").replace(/\/$/u, "");
}
async function runNpm(arguments_, cwd) {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? execFile(process.execPath, [npmCli, ...arguments_], { cwd, maxBuffer: 20 * 1024 * 1024 })
    : execFile("npm", arguments_, { cwd, maxBuffer: 20 * 1024 * 1024 });
}
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  options.set(process.argv[index], process.argv[index + 1]);
}
const source = options.get("--repository");
const id = options.get("--id");
if (!source || !id) {
  console.error("Usage: npm run validate:repository -- --repository PATH --id AUDIT_ID");
  process.exitCode = 2;
} else {
  const sourceRoot = path.resolve(source);
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error(`${sourceRoot} is not a directory.`);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codeatlas-release-validation-"));
  const cloneRoot = path.join(temporaryRoot, "repository");
  const consumerRoot = path.join(temporaryRoot, "consumer");
  try {
    const { stdout: originOutput } = await execFile(
      "git",
      ["-C", sourceRoot, "remote", "get-url", "origin"],
    );
    const repository = normalizeRepositoryUrl(originOutput.trim());
    await execFile("git", ["clone", "--local", "--no-hardlinks", "--quiet", sourceRoot, cloneRoot], {
      maxBuffer: 20 * 1024 * 1024,
    });
    const { stdout: commitOutput } = await execFile("git", ["-C", cloneRoot, "rev-parse", "HEAD"]);
    const commit = commitOutput.trim();

    await mkdir(consumerRoot, { recursive: true });
    await writeFile(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "codeatlas-release-validator", private: true }, null, 2)}\n`,
      "utf8",
    );
    const { stdout: packOutput } = await runNpm(
      ["pack", "--json", "--silent", "--pack-destination", temporaryRoot],
      process.cwd(),
    );
    const packed = JSON.parse(packOutput);
    const filename = packed[0]?.filename;
    if (typeof filename !== "string") throw new Error("npm pack did not return a tarball filename.");
    const tarball = path.join(temporaryRoot, filename);
    await runNpm(["install", "--no-audit", "--no-fund", tarball], consumerRoot);

    const installedRoot = path.join(
      consumerRoot,
      "node_modules",
      "@dinesh-das",
      "codeatlas",
    );
    const cli = path.join(installedRoot, "dist", "cli", "index.js");
    const api = path.join(installedRoot, "dist", "api.js");
    await execFile(
      process.execPath,
      [
        `--max-old-space-size=${STABLE_RELEASE_BUDGETS.validationHeapMiB}`,
        cli,
        "build",
        cloneRoot,
        "--full",
        "--no-snapshot",
        "--json",
      ],
      { cwd: cloneRoot, maxBuffer: 40 * 1024 * 1024 },
    );
    const { stdout: doctorOutput } = await execFile(process.execPath, [cli, "doctor", cloneRoot], {
      cwd: cloneRoot,
      maxBuffer: 20 * 1024 * 1024,
    });
    const atlasPath = path.join(cloneRoot, ".codeatlas", "current", "atlas.json");
    const atlasText = await readFile(atlasPath, "utf8");
    const atlas = JSON.parse(atlasText);
    const agentProbe = `
      import { readFile } from "node:fs/promises";
      const installedApi = await import(process.env.CODEATLAS_VALIDATOR_API);
      const atlas = JSON.parse(await readFile(process.env.CODEATLAS_VALIDATOR_ATLAS, "utf8"));
      const answer = installedApi.answerFromAtlas(
        atlas,
        "Explain the repository architecture and where an AI coding agent should start.",
      );
      const quality = installedApi.evaluateArchitectureAnswer(atlas, answer);
      console.log(JSON.stringify({
        version: installedApi.CODEATLAS_VERSION,
        quality,
      }));
    `;
    const { stdout: agentProbeOutput } = await execFile(
      process.execPath,
      ["--input-type=module", "--eval", agentProbe],
      {
        cwd: consumerRoot,
        env: {
          ...process.env,
          CODEATLAS_VALIDATOR_API: pathToFileURL(api).href,
          CODEATLAS_VALIDATOR_ATLAS: atlasPath,
        },
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    const agentResult = JSON.parse(agentProbeOutput);
    const quality = doctorOutput.match(
      /verified=\d+ \(([\d.]+)%\).*actionable_unresolved=\d+ \(([\d.]+)%\)/u,
    );
    if (!quality) throw new Error("Could not read relationship quality from doctor output.");
    const operatingSystem = process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : "linux";
    const languages = [...new Set(
      atlas.symbols
        .map((symbol) => symbol.language)
        .filter((language) => ["typescript", "javascript", "python"].includes(language)),
    )].sort();
    const result = {
      id,
      repository,
      commit,
      validatedAt: new Date().toISOString(),
      codeAtlasVersion: agentResult.version,
      atlasSha256: createHash("sha256").update(atlasText).digest("hex"),
      operatingSystem,
      languages,
      checks: {
        install: true,
        index: atlas.statistics.files > 0,
        overview: atlas.domains.length > 0 && atlas.symbols.length > 0,
        agentQuestion: agentResult.quality.passed === true,
        noIndexingFailures: doctorOutput.includes("[OK] Indexing failures: none"),
      },
      verifiedRelationshipPercent: Number(quality[1]),
      unresolvedRelationshipPercent: Number(quality[2]),
    };
    const serializedResult = `${JSON.stringify(result, null, 2)}\n`;
    const requestedOutput = options.get("--output");
    if (requestedOutput !== undefined) {
      const outputPath = path.resolve(requestedOutput);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, serializedResult, "utf8");
    }
    const failedChecks = Object.entries(result.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failedChecks.length > 0) {
      const doctorDiagnostic = doctorOutput
        .split(/\r?\n/u)
        .find((line) => line.includes("Indexing failures"));
      throw new Error(
        `Repository validation failed: ${failedChecks.join(", ")}.${
          doctorDiagnostic === undefined ? "" : ` ${doctorDiagnostic}`
        }`,
      );
    }
    repositoryValidationSchema.parse(result);
    if (
      result.verifiedRelationshipPercent <
      STABLE_RELEASE_BUDGETS.minimumVerifiedRelationshipPercent
    ) {
      throw new Error(
        `Repository has less than ${STABLE_RELEASE_BUDGETS.minimumVerifiedRelationshipPercent}% verified relationships.`,
      );
    }
    if (
      result.unresolvedRelationshipPercent >
      STABLE_RELEASE_BUDGETS.maximumUnresolvedRelationshipPercent
    ) {
      throw new Error(
        `Repository has more than ${STABLE_RELEASE_BUDGETS.maximumUnresolvedRelationshipPercent}% unresolved relationships.`,
      );
    }
    if (result.languages.length === 0) {
      throw new Error("Repository contains no supported TypeScript, JavaScript, or Python source.");
    }
    console.log(serializedResult.trimEnd());
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}
