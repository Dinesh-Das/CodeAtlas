import { sha256 } from "../core/hashing.js";
import type { EdgeType, NodeKind } from "./types.js";

export function createNodeId(
  repositoryId: string,
  nodeKind: NodeKind,
  relativeFilePath: string,
  qualifiedName: string,
): string {
  return sha256(`${repositoryId}:${nodeKind}:${relativeFilePath}:${qualifiedName}`);
}

export function createEdgeId(
  repositoryId: string,
  edgeType: EdgeType,
  sourceNodeId: string,
  targetNodeId: string,
  filePath = "",
  line: number | null = null,
): string {
  return sha256(
    `${repositoryId}:${edgeType}:${sourceNodeId}:${targetNodeId}:${filePath}:${line ?? ""}`,
  );
}
