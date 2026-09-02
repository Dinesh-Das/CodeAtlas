import { readFile } from "node:fs/promises";
import { validateStableReleaseEvidence } from "../dist/release/evidence.js";
import { createPackageFingerprint } from "./package-fingerprint.mjs";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
const sourceVersion = await readFile("src/version.ts", "utf8");
const changelog = await readFile("CHANGELOG.md", "utf8");
const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
const codeqlWorkflow = await readFile(".github/workflows/codeql.yml", "utf8");
const evidenceWorkflow = await readFile(".github/workflows/release-evidence.yml", "utf8");
const evidence = JSON.parse(await readFile("release-evidence.json", "utf8"));
const version = packageJson.version;
const errors = [];

if (packageLock.version !== version || packageLock.packages?.[""]?.version !== version) {
  errors.push("package-lock.json is not synchronized with package.json.");
}
if (!sourceVersion.includes(`CODEATLAS_VERSION = "${version}"`)) {
  errors.push("src/version.ts is not synchronized with package.json.");
}
if (!changelog.includes(`## ${version} -`)) {
  errors.push(`CHANGELOG.md has no dated ${version} release entry.`);
}
if (!releaseWorkflow.includes("id-token: write") || !releaseWorkflow.includes("--provenance")) {
  errors.push("The release workflow must use OIDC and explicit npm provenance.");
}
for (const [name, workflow] of [
  ["ci.yml", ciWorkflow],
  ["codeql.yml", codeqlWorkflow],
  ["release-evidence.yml", evidenceWorkflow],
  ["release.yml", releaseWorkflow],
]) {
  const mutableActions = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/gu)]
    .map((match) => match[1] ?? "")
    .filter((reference) => !/^[0-9a-f]{40}$/iu.test(reference));
  if (mutableActions.length > 0) {
    errors.push(`${name} contains mutable action references: ${mutableActions.join(", ")}.`);
  }
}

const packageFingerprint = await createPackageFingerprint(process.cwd());
const stableEvidence = validateStableReleaseEvidence(version, evidence, {
  codeAtlasVersion: version,
  ...packageFingerprint,
});
const stableRequested = process.argv.includes("--stable") || !version.includes("-");
if (stableRequested && !stableEvidence.ready) errors.push(...stableEvidence.errors);

if (errors.length > 0) {
  console.error(`Release gate failed:\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
} else if (stableEvidence.ready) {
  console.log(`Stable evidence ready: ${stableEvidence.repositoryCount} independent repositories.`);
} else {
  console.log(
    `Prerelease gate passed. Stable evidence remains incomplete (${stableEvidence.repositoryCount}/10 repositories).`,
  );
}
