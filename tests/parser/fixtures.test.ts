import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DetectedLanguage } from "../../src/core/languages.js";
import { sha256 } from "../../src/core/hashing.js";
import { createNodeId } from "../../src/graph/ids.js";
import type { ParsedFile } from "../../src/parser/parser.js";
import { getLanguageAdapter } from "../../src/parser/registry.js";

interface CompactSnapshot {
  nodes: string[];
  edges: string[];
  unresolvedReferences: string[];
  errors: string[];
}

const fixtures: Array<{ language: DetectedLanguage; filename: string }> = [
  { language: "typescript", filename: "input.ts" },
  { language: "javascript", filename: "input.js" },
  { language: "tsx", filename: "input.tsx" },
  { language: "jsx", filename: "input.jsx" },
  { language: "python", filename: "input.py" },
];

function compactSnapshot(
  parsed: ParsedFile,
  repositoryId: string,
  relativeFilePath: string,
): CompactSnapshot {
  const labels = new Map(parsed.nodes.map((node) => [node.id, `${node.kind}:${node.qualifiedName}`]));
  labels.set(
    createNodeId(repositoryId, "file", relativeFilePath, relativeFilePath),
    `file:${relativeFilePath}`,
  );

  return {
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
}

describe.each(fixtures)("$language structural parser fixture", ({ language, filename }) => {
  it("matches the deterministic normalized graph snapshot", async () => {
    const fixtureDirectory = path.resolve("tests", "fixtures", language, "structural");
    const content = await readFile(path.join(fixtureDirectory, filename), "utf8");
    const expected = JSON.parse(
      await readFile(path.join(fixtureDirectory, "expected.json"), "utf8"),
    ) as CompactSnapshot;
    const adapter = getLanguageAdapter(language);
    expect(adapter).not.toBeNull();
    const input = {
      repositoryId: "fixture-repository",
      repositoryRoot: ".",
      relativeFilePath: `src/${filename}`,
      language,
      content,
      contentHash: sha256(content),
    };

    const first = adapter!.parseFile(input);
    const second = adapter!.parseFile(input);
    expect(compactSnapshot(first, input.repositoryId, input.relativeFilePath)).toEqual(expected);
    expect(second).toEqual(first);
  });
});

describe("parser invariants", () => {
  it("attaches deterministic evidence and never persists string literal values", () => {
    const adapter = getLanguageAdapter("typescript");
    const parsed = adapter!.parseFile({
      repositoryId: "repo",
      repositoryRoot: ".",
      relativeFilePath: "src/secrets.ts",
      language: "typescript",
      content:
        'export class Vault { private token = "must-not-persist"; open(value: string = "also-hidden") { return value; } }',
      contentHash: "hash",
    });

    for (const node of parsed.nodes) {
      expect(node.sourceType).toBe("ast");
      expect(node.confidence).toBe(1);
      expect(node.startLine).toBeGreaterThan(0);
      expect(node.metadata).toHaveProperty("evidence.file", "src/secrets.ts");
    }
    for (const edge of parsed.edges) {
      expect(edge.sourceType).toBe("ast");
      expect(edge.confidence).toBe(1);
      expect(edge.filePath).toBe("src/secrets.ts");
      expect(edge.metadata).toHaveProperty("evidence.line");
    }
    const persistedGraph = JSON.stringify({ nodes: parsed.nodes, edges: parsed.edges });
    expect(persistedGraph).not.toContain("must-not-persist");
    expect(persistedGraph).not.toContain("also-hidden");
    expect(persistedGraph).toContain("<literal>");
  });

  it("reports syntax errors while retaining grounded partial structure", () => {
    const adapter = getLanguageAdapter("python");
    const parsed = adapter!.parseFile({
      repositoryId: "repo",
      repositoryRoot: ".",
      relativeFilePath: "broken.py",
      language: "python",
      content: "def broken(:\n    return True\n",
      contentHash: "hash",
    });

    expect(parsed.errors).not.toHaveLength(0);
    expect(parsed.errors[0]).toMatchObject({
      severity: "error",
      evidence: { sourceType: "ast", file: "broken.py" },
    });
  });

  it("marks convention-based Python exports as heuristic", () => {
    const adapter = getLanguageAdapter("python");
    const parsed = adapter!.parseFile({
      repositoryId: "repo",
      repositoryRoot: ".",
      relativeFilePath: "module.py",
      language: "python",
      content: "def public():\n    pass\n\ndef _private():\n    pass\n",
      contentHash: "hash",
    });
    const exports = parsed.edges.filter((edge) => edge.edgeType === "EXPORTS");

    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ sourceType: "heuristic", confidence: 0.7 });
  });

  it("normalizes TypeScript overloads and abstract declarations without graph churn", () => {
    const adapter = getLanguageAdapter("typescript");
    const parsed = adapter!.parseFile({
      repositoryId: "repo",
      repositoryRoot: ".",
      relativeFilePath: "overloads.ts",
      language: "typescript",
      content: [
        "export function parse(value: string): string;",
        "export function parse(value: unknown) { return value; }",
        "abstract class Worker { abstract run(value: string): void; }",
      ].join("\n"),
      contentHash: "hash",
    });

    expect(parsed.nodes.filter((node) => node.qualifiedName === "parse")).toHaveLength(1);
    expect(parsed.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "class", qualifiedName: "Worker" }),
        expect.objectContaining({ kind: "method", qualifiedName: "Worker.run" }),
      ]),
    );
  });
});
