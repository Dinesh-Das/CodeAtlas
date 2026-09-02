import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency } from "../core/async.js";
import type { DiscoveredFile } from "../core/discovery.js";
import {
  isLanguageEnabled,
  isSourceLanguage,
  type DetectedLanguage,
} from "../core/languages.js";
import { workspaceManifestPaths } from "../core/workspace-packages.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { ParsedFile } from "../parser/parser.js";
import type { FileRecord } from "../storage/files.js";
import type { FileSemanticFacts } from "./semantic-delta.js";

export interface IndexedCandidate {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  language: DetectedLanguage | null;
  contentHash: string;
  parseStatus: string;
  adapterVersion: string;
  parsedFile: ParsedFile | null;
  content: string | null;
  semanticFacts: FileSemanticFacts | null;
  detectedFrameworks: string[];
}

export interface WorkspacePackage {
  directory: string;
  manifestPath: string;
  name: string;
  version: string | null;
  isPrivate: boolean;
  dependencies: string[];
  hasExports: boolean;
}

export async function loadWorkspacePackages(
  candidates: readonly IndexedCandidate[],
  repositoryRoot: string,
): Promise<WorkspacePackage[]> {
  const indexedPaths = new Set(candidates.map((candidate) => candidate.relativePath));
  const manifestsInWorkspace = workspaceManifestPaths(repositoryRoot, indexedPaths);
  const manifests = candidates.filter((candidate) =>
    manifestsInWorkspace.has(candidate.relativePath),
  );
  const packages = await mapWithConcurrency(manifests, 16, async (candidate) => {
    try {
      const value = JSON.parse(await readFile(candidate.absolutePath, "utf8")) as {
        name?: unknown;
        version?: unknown;
        private?: unknown;
        exports?: unknown;
        dependencies?: unknown;
        devDependencies?: unknown;
        peerDependencies?: unknown;
        optionalDependencies?: unknown;
      };
      if (typeof value.name !== "string" || value.name.trim() === "") return null;
      const dependencyNames = [
        value.dependencies,
        value.devDependencies,
        value.peerDependencies,
        value.optionalDependencies,
      ].flatMap((dependencies) =>
        typeof dependencies === "object" && dependencies !== null
          ? Object.keys(dependencies)
          : [],
      );
      return {
        directory: path.posix.dirname(candidate.relativePath),
        manifestPath: candidate.relativePath,
        name: value.name,
        version: typeof value.version === "string" ? value.version : null,
        isPrivate: value.private === true,
        dependencies: [...new Set(dependencyNames)].sort((left, right) =>
          left.localeCompare(right),
        ),
        hasExports: value.exports !== undefined,
      } satisfies WorkspacePackage;
    } catch {
      return null;
    }
  });
  return packages
    .filter((entry): entry is WorkspacePackage => entry !== null)
    .sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

export function owningPackage(
  filePath: string,
  packageByDirectory: ReadonlyMap<string, WorkspacePackage>,
): WorkspacePackage | null {
  let current = path.posix.dirname(filePath);
  while (true) {
    const owner = packageByDirectory.get(current);
    if (owner !== undefined) return owner;
    if (current === ".") return null;
    current = path.posix.dirname(current);
  }
}

export function initialParseStatus(
  language: DetectedLanguage | null,
  enabled: { typescript: boolean; javascript: boolean; python: boolean },
  hasAdapter: boolean,
  hasFrameworkAdapter: boolean,
  hasIntentAdapter: boolean,
): string {
  if (hasIntentAdapter && language === null) return "pending_intent";
  if (
    hasFrameworkAdapter &&
    (language === null || isLanguageEnabled(language, enabled)) &&
    !isSourceLanguage(language)
  ) {
    return "pending_framework";
  }
  if (language === null) return "unsupported";
  if (!isLanguageEnabled(language, enabled)) return "disabled";
  if (isSourceLanguage(language)) return hasAdapter ? "pending_parse" : "unsupported_parser";
  return "metadata_only";
}

export function statusMatches(previous: string, current: string): boolean {
  if (current === "pending_parse") {
    return previous === "parsed" || previous === "parsed_with_errors" || previous === "parse_error";
  }
  if (current === "pending_framework") {
    return previous === "parsed" || previous === "metadata_only" || previous === "parse_error";
  }
  if (current === "pending_intent") return previous === "parsed_intent";
  return previous === current;
}

export function graphNode(
  input: Partial<GraphNode> & Pick<GraphNode, "id" | "kind" | "name">,
): GraphNode {
  return {
    qualifiedName: null,
    filePath: null,
    language: null,
    startLine: null,
    startColumn: null,
    endLine: null,
    endColumn: null,
    signature: null,
    visibility: null,
    contentHash: null,
    sourceType: "git",
    provenance: "git",
    confidence: 1,
    metadata: {},
    ...input,
  };
}

export function graphEdge(
  input: Partial<GraphEdge> &
    Pick<GraphEdge, "id" | "sourceNodeId" | "targetNodeId" | "edgeType">,
): GraphEdge {
  return {
    sourceType: "git",
    provenance: "git",
    confidence: 1,
    filePath: null,
    line: null,
    metadata: {},
    ...input,
  };
}

export function getDirectoryPaths(files: readonly IndexedCandidate[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let current = path.posix.dirname(file.relativePath);
    while (current !== ".") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

export async function readCreatedAt(manifestPath: string, fallback: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { createdAt?: unknown };
    return typeof manifest.createdAt === "string" ? manifest.createdAt : fallback;
  } catch {
    return fallback;
  }
}

export async function discoverFromManifest(
  repositoryRoot: string,
  existing: ReadonlyMap<string, FileRecord>,
  changedPaths: ReadonlySet<string>,
  ignoreRules: { ignores(relativePath: string, isDirectory?: boolean): boolean },
): Promise<DiscoveredFile[]> {
  const result = new Map<string, DiscoveredFile>();
  for (const previous of existing.values()) {
    if (changedPaths.has(previous.path)) continue;
    result.set(previous.path, {
      absolutePath: path.join(repositoryRoot, ...previous.path.split("/")),
      relativePath: previous.path,
      sizeBytes: previous.sizeBytes,
      mtimeMs: previous.mtimeMs ?? 0,
      ctimeMs: previous.ctimeMs ?? 0,
    });
  }
  await mapWithConcurrency([...changedPaths], 32, async (relativePath) => {
    if (ignoreRules.ignores(relativePath)) return;
    const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
    try {
      const metadata = await stat(absolutePath);
      if (!metadata.isFile()) return;
      result.set(relativePath, {
        absolutePath,
        relativePath,
        sizeBytes: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
      });
    } catch {
      result.delete(relativePath);
    }
  });
  return [...result.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
