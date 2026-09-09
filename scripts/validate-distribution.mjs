import { readFile } from "node:fs/promises";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const [packageMetadata, server, compatibility, evidence, adapterExpected, adapterActual] =
  await Promise.all([
    readJson("package.json"),
    readJson("server.json"),
    readJson("compatibility.json"),
    readJson("release-evidence.json"),
    readJson("examples/adapter-kit/expected.json"),
    readJson("examples/adapter-kit/actual.json"),
  ]);
const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
const errors = [];
const failUnless = (condition, message) => {
  if (!condition) errors.push(message);
};

failUnless(server.name === packageMetadata.mcpName, "server name must match package.json#mcpName");
failUnless(server.version === packageMetadata.version, "server version must match package version");
failUnless(server.repository?.url === "https://github.com/Dinesh-Das/CodeAtlas", "server repository is not canonical");
failUnless(server.packages?.[0]?.identifier === packageMetadata.name, "registry npm identifier must match package name");
failUnless(server.packages?.[0]?.version === packageMetadata.version, "registry package version must match package version");
failUnless(server.packages?.[0]?.transport?.type === "stdio", "registry transport must be stdio");
failUnless(server.packages?.[0]?.packageArguments?.[0]?.value === "mcp", "registry package must launch the mcp subcommand");
failUnless(server.packages?.[0]?.packageArguments?.[1]?.format === "filepath", "registry package must request a repository path");
failUnless(server.$schema === "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", "registry schema must be pinned");
failUnless(!JSON.stringify(server).includes("latest"), "registry manifest must not contain an unpinned latest version");
failUnless(releaseWorkflow.includes("mcp-publisher_linux_amd64.tar.gz"), "release workflow does not install the MCP publisher");
failUnless(releaseWorkflow.includes("ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac"), "release workflow does not verify the publisher checksum");
failUnless(releaseWorkflow.includes("login github-oidc"), "release workflow does not use registry OIDC");
failUnless(releaseWorkflow.includes('mcp-publisher" publish'), "release workflow does not publish the registry manifest");

const setupTargets = new Set(compatibility.targets.map((target) => target.setupTarget));
for (const target of ["codex", "claude", "cursor", "vscode", "copilot", "antigravity"]) {
  failUnless(setupTargets.has(target), `compatibility matrix is missing setup target ${target}`);
}
failUnless(compatibility.codeAtlasVersion === packageMetadata.version, "compatibility matrix version is stale");
for (const operatingSystem of ["linux", "macos", "windows"]) {
  failUnless(compatibility.continuousIntegration.operatingSystems.includes(operatingSystem), `CI matrix is missing ${operatingSystem}`);
}

const repositories = new Set(evidence.independentRepositories.map((entry) => entry.repository.toLowerCase().replace(/\/$/u, "")));
failUnless(repositories.size >= 10, "release evidence must include ten independent repositories");
for (const entry of evidence.independentRepositories) {
  failUnless(/^[0-9a-f]{40}$/iu.test(entry.commit), `${entry.id} is not pinned to a full commit`);
  failUnless(/^[0-9a-f]{64}$/iu.test(entry.atlasSha256), `${entry.id} is missing an atlas checksum`);
}

const edgeKey = (edge) => `${edge.source}\0${edge.type}\0${edge.target}`;
const expectedEdges = new Set(adapterExpected.edges.map(edgeKey));
const actualEdges = new Set(adapterActual.edges.map(edgeKey));
const matches = [...actualEdges].filter((edge) => expectedEdges.has(edge)).length;
const precision = actualEdges.size === 0 ? 0 : matches / actualEdges.size;
const recall = expectedEdges.size === 0 ? 1 : matches / expectedEdges.size;
failUnless(precision >= adapterExpected.gates.minimumPrecision, "adapter kit precision gate failed");
failUnless(recall >= adapterExpected.gates.minimumRecall, "adapter kit recall gate failed");

for (const example of ["examples/mcp-config.json", "examples/vscode-mcp.json", "examples/copilot-mcp.json"]) {
  await readJson(example);
}

if (errors.length > 0) {
  console.error(`Distribution validation failed:\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Distribution manifests passed: ${compatibility.targets.length} hosts, ${repositories.size} pinned repositories, adapter precision=${precision.toFixed(2)}, recall=${recall.toFixed(2)}.`);
}
