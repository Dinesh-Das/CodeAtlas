import path from "node:path";
import { sha256 } from "../core/hashing.js";
import type { DetectedLanguage } from "../core/languages.js";
import { createEdgeId, createNodeId } from "../graph/ids.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { ParsedFile } from "../parser/parser.js";

export interface IntentContext {
  repositoryId: string;
  relativeFilePath: string;
  language: DetectedLanguage | null;
  content: string;
  contentHash: string;
  parsedFile: ParsedFile | null;
}

const DOCUMENT_PATTERN = /(?:^|\/)(?:readme(?:\.[^/]*)?|docs?\/|adr(?:s)?\/)|\.(?:md|mdx|rst)$/iu;
const TEST_PATTERN = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[^.]+$/iu;
const INTENT_COMMENT = /\b(TODO|FIXME|ADR|ARCHITECTURE|INVARIANT|DEPRECATED|SECURITY|INTENT)\b/iu;

function evidence(file: string, line: number, sourceType: "ast" | "documentation") {
  return { source_type: sourceType, file, line, column: 0 };
}

function intentNode(
  context: IntentContext,
  input: {
    kind: "documentation" | "test";
    name: string;
    qualifiedName: string;
    startLine: number;
    endLine: number;
    sourceType: "ast" | "documentation";
    confidence: number;
    metadata: Record<string, unknown>;
  },
): GraphNode {
  return {
    id: createNodeId(
      context.repositoryId,
      input.kind,
      context.relativeFilePath,
      input.qualifiedName,
    ),
    kind: input.kind,
    name: input.name.slice(0, 160),
    qualifiedName: input.qualifiedName,
    filePath: context.relativeFilePath,
    language: context.language,
    startLine: input.startLine,
    startColumn: 0,
    endLine: input.endLine,
    endColumn: 0,
    signature: null,
    visibility: null,
    contentHash: context.contentHash,
    sourceType: input.sourceType,
    provenance: input.sourceType === "documentation" ? "documentation" : "verified",
    confidence: input.confidence,
    metadata: {
      evidence: evidence(context.relativeFilePath, input.startLine, input.sourceType),
      trust: "untrusted_repository_content",
      ...input.metadata,
    },
  };
}

function containmentEdge(context: IntentContext, node: GraphNode): GraphEdge {
  const fileNodeId = createNodeId(
    context.repositoryId,
    "file",
    context.relativeFilePath,
    context.relativeFilePath,
  );
  return {
    id: createEdgeId(
      context.repositoryId,
      "CONTAINS",
      fileNodeId,
      node.id,
      context.relativeFilePath,
      node.startLine ?? 1,
    ),
    sourceNodeId: fileNodeId,
    targetNodeId: node.id,
    edgeType: "CONTAINS",
    sourceType: node.sourceType,
    provenance: node.provenance,
    confidence: node.confidence,
    filePath: context.relativeFilePath,
    line: node.startLine,
    metadata: {
      evidence: evidence(
        context.relativeFilePath,
        node.startLine ?? 1,
        node.sourceType === "documentation" ? "documentation" : "ast",
      ),
      intent_relationship: true,
    },
  };
}

function documentNodes(context: IntentContext): GraphNode[] {
  if (!DOCUMENT_PATTERN.test(context.relativeFilePath)) return [];
  const lines = context.content.split(/\r?\n/u);
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match === null) return [];
    return [{ line: index + 1, level: match[1]!.length, title: match[2]!.trim() }];
  }).slice(0, 200);
  const sections = headings.length === 0
    ? [{ line: 1, level: 1, title: path.posix.basename(context.relativeFilePath) }]
    : headings;
  return sections.map((section, index) => {
    const next = sections[index + 1];
    const endLine = Math.max(section.line, (next?.line ?? lines.length + 1) - 1);
    const documentKind = /(?:^|\/)adr(?:s)?\//iu.test(context.relativeFilePath)
      ? "adr"
      : /(?:^|\/)readme/iu.test(context.relativeFilePath)
        ? "readme"
        : "documentation";
    return intentNode(context, {
      kind: "documentation",
      name: section.title,
      qualifiedName: `documentation:${context.relativeFilePath}:${section.line}`,
      startLine: section.line,
      endLine,
      sourceType: "documentation",
      confidence: 0.9,
      metadata: {
        document_kind: documentKind,
        heading_level: section.level,
        heading_hash: sha256(section.title),
        explanation_source: "repository_documentation",
      },
    });
  });
}

function testNode(context: IntentContext): GraphNode[] {
  if (!TEST_PATTERN.test(context.relativeFilePath)) return [];
  const lineCount = context.content.split(/\r?\n/u).length;
  return [
    intentNode(context, {
      kind: "test",
      name: path.posix.basename(context.relativeFilePath),
      qualifiedName: `test:${context.relativeFilePath}`,
      startLine: 1,
      endLine: lineCount,
      sourceType: "ast",
      confidence: 1,
      metadata: { intent_source: "test_file_path" },
    }),
  ];
}

function commentNodes(context: IntentContext): GraphNode[] {
  if (context.parsedFile === null) return [];
  const lines = context.content.split(/\r?\n/u);
  const result: GraphNode[] = [];
  for (let index = 0; index < lines.length && result.length < 100; index += 1) {
    const line = lines[index]!;
    if (!/^\s*(?:\/\/|\/\*|\*|#)/u.test(line)) continue;
    const match = INTENT_COMMENT.exec(line);
    if (match === null) continue;
    const lineNumber = index + 1;
    const nearest = context.parsedFile.nodes
      .filter((node) => (node.startLine ?? Number.MAX_SAFE_INTEGER) >= lineNumber)
      .sort((left, right) => (left.startLine ?? 0) - (right.startLine ?? 0))[0];
    const category = match[1]!.toUpperCase();
    result.push(
      intentNode(context, {
        kind: "documentation",
        name: `${category} note${nearest === undefined ? "" : ` for ${nearest.name}`}`,
        qualifiedName: `comment:${context.relativeFilePath}:${lineNumber}`,
        startLine: lineNumber,
        endLine: lineNumber,
        sourceType: "documentation",
        confidence: 0.8,
        metadata: {
          document_kind: "code_comment",
          comment_category: category,
          comment_hash: sha256(line.trim()),
          related_node_id: nearest?.id ?? null,
          explanation_source: "repository_comment",
        },
      }),
    );
  }
  return result;
}

export function supportsArchitecturalIntent(
  relativeFilePath: string,
  language: DetectedLanguage | null,
): boolean {
  return (
    DOCUMENT_PATTERN.test(relativeFilePath) ||
    TEST_PATTERN.test(relativeFilePath) ||
    language === "typescript" ||
    language === "tsx" ||
    language === "javascript" ||
    language === "jsx" ||
    language === "python"
  );
}

export function mergeArchitecturalIntent(context: IntentContext): ParsedFile | null {
  const addedNodes = [
    ...documentNodes(context),
    ...testNode(context),
    ...commentNodes(context),
  ];
  if (addedNodes.length === 0) return context.parsedFile;
  const base: ParsedFile = context.parsedFile ?? {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [],
  };
  const nodes = new Map(base.nodes.map((node) => [node.id, node]));
  const edges = new Map(base.edges.map((edge) => [edge.id, edge]));
  for (const node of addedNodes) {
    nodes.set(node.id, node);
    const edge = containmentEdge(context, node);
    edges.set(edge.id, edge);
  }
  return { ...base, nodes: [...nodes.values()], edges: [...edges.values()] };
}
