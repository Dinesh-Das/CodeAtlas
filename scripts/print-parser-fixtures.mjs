import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../dist/core/hashing.js";
import { createNodeId } from "../dist/graph/ids.js";
import { getLanguageAdapter } from "../dist/parser/registry.js";

const fixtures = [
  ["typescript", "input.ts"],
  ["javascript", "input.js"],
  ["tsx", "input.tsx"],
  ["jsx", "input.jsx"],
  ["python", "input.py"],
];

for (const [language, filename] of fixtures) {
  const fixturePath = path.resolve("tests", "fixtures", language, "structural", filename);
  const content = await readFile(fixturePath, "utf8");
  const relativeFilePath = `src/${filename}`;
  const repositoryId = "fixture-repository";
  const adapter = getLanguageAdapter(language);
  if (adapter === null) throw new Error(`Missing adapter for ${language}`);
  const parsed = adapter.parseFile({
    repositoryId,
    repositoryRoot: ".",
    relativeFilePath,
    language,
    content,
    contentHash: sha256(content),
  });
  const labels = new Map(parsed.nodes.map((node) => [node.id, `${node.kind}:${node.qualifiedName}`]));
  labels.set(
    createNodeId(repositoryId, "file", relativeFilePath, relativeFilePath),
    `file:${relativeFilePath}`,
  );
  const snapshot = {
    nodes: parsed.nodes.map(
      (node) =>
        `${node.kind}|${node.qualifiedName}|${node.startLine}|${node.signature ?? "-"}|${node.visibility ?? "-"}|${node.sourceType}|${node.confidence}`,
    ),
    edges: parsed.edges.map(
      (edge) =>
        `${edge.edgeType}|${labels.get(edge.sourceNodeId)}|${labels.get(edge.targetNodeId)}|${edge.line}|${edge.sourceType}|${edge.confidence}`,
    ),
    unresolvedReferences: parsed.unresolvedReferences.map(
      (reference) =>
        `${reference.kind}|${reference.name}|${reference.evidence.line}|${reference.evidence.column}|${reference.evidence.sourceType}`,
    ),
    errors: parsed.errors.map(
      (error) => `${error.severity}|${error.evidence.line}|${error.evidence.column}|${error.message}`,
    ),
  };
  process.stdout.write(`===${language}===\n${JSON.stringify(snapshot, null, 2)}\n`);
}
