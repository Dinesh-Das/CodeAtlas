import { sha256 } from "../core/hashing.js";
import { createEdgeId, createNodeId } from "../graph/ids.js";
import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  NodeKind,
  SourceType,
} from "../graph/types.js";
import { provenanceForSource } from "../graph/types.js";
import type { SyntaxNode } from "../parser/tree-sitter.js";
import type { RepositoryContext } from "./types.js";

export interface FrameworkLocation {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export function locationFor(node: SyntaxNode): FrameworkLocation {
  return {
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
  };
}

export function frameworkNode(
  context: RepositoryContext,
  input: {
    kind: NodeKind;
    name: string;
    qualifiedName: string;
    location: FrameworkLocation;
    framework: string;
    sourceType?: SourceType;
    confidence?: number;
    signature?: string | null;
    metadata?: Record<string, unknown>;
  },
): GraphNode {
  const sourceType = input.sourceType ?? "framework";
  return {
    id: createNodeId(
      context.repositoryId,
      input.kind,
      context.relativeFilePath,
      input.qualifiedName,
    ),
    kind: input.kind,
    name: input.name,
    qualifiedName: input.qualifiedName,
    filePath: context.relativeFilePath,
    language: context.language,
    startLine: input.location.line,
    startColumn: input.location.column,
    endLine: input.location.endLine,
    endColumn: input.location.endColumn,
    signature: input.signature ?? null,
    visibility: null,
    contentHash: context.contentHash,
    sourceType,
    provenance: provenanceForSource(sourceType),
    confidence: input.confidence ?? 1,
    metadata: {
      evidence: {
        source_type: sourceType,
        file: context.relativeFilePath,
        line: input.location.line,
        column: input.location.column,
      },
      framework: input.framework,
      ...(input.metadata ?? {}),
    },
  };
}

export function frameworkEdge(
  context: RepositoryContext,
  input: {
    edgeType: EdgeType;
    sourceNodeId: string;
    targetNodeId: string;
    location: Pick<FrameworkLocation, "line" | "column">;
    sourceType?: SourceType;
    confidence?: number;
    metadata?: Record<string, unknown>;
  },
): GraphEdge {
  const sourceType = input.sourceType ?? "framework";
  return {
    id: createEdgeId(
      context.repositoryId,
      input.edgeType,
      input.sourceNodeId,
      input.targetNodeId,
      context.relativeFilePath,
      input.location.line,
    ),
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    edgeType: input.edgeType,
    sourceType,
    provenance: provenanceForSource(sourceType),
    confidence: input.confidence ?? 1,
    filePath: context.relativeFilePath,
    line: input.location.line,
    metadata: {
      evidence: {
        source_type: sourceType,
        file: context.relativeFilePath,
        line: input.location.line,
        column: input.location.column,
      },
      ...(input.metadata ?? {}),
    },
  };
}

export function containerNodeId(context: RepositoryContext): string {
  return (
    context.parsedFile?.nodes.find((node) => node.kind === "module")?.id ??
    createNodeId(
      context.repositoryId,
      "file",
      context.relativeFilePath,
      context.relativeFilePath,
    )
  );
}

export function symbolNodeId(
  context: RepositoryContext,
  name: string,
  kinds: readonly NodeKind[],
): string | null {
  return (
    context.parsedFile?.nodes.find(
      (node) => node.name === name && kinds.includes(node.kind),
    )?.id ?? null
  );
}

export function literalHash(kind: string, value: string): string {
  return sha256(`${kind}:${value}`);
}
