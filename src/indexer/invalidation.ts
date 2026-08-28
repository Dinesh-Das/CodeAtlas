import path from "node:path";
import { sha256 } from "../core/hashing.js";
import type { AtlasDatabase } from "../storage/database.js";

interface ResolutionIssueRow {
  file_path: string;
  reference_hash: string;
}

function relativeModulePath(sourceFile: string, targetFile: string): string {
  const relative = path.posix.relative(path.posix.dirname(sourceFile), targetFile);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function javascriptSpecifiers(sourceFile: string, targetFile: string): Set<string> {
  const specifiers = new Set<string>();
  const relative = relativeModulePath(sourceFile, targetFile);
  const extension = path.posix.extname(relative);
  const withoutExtension = extension === "" ? relative : relative.slice(0, -extension.length);
  specifiers.add(relative);
  specifiers.add(withoutExtension);

  const runtimeExtension =
    extension === ".ts" || extension === ".tsx"
      ? ".js"
      : extension === ".mts"
        ? ".mjs"
        : extension === ".cts"
          ? ".cjs"
          : null;
  if (runtimeExtension !== null) specifiers.add(`${withoutExtension}${runtimeExtension}`);

  const basename = path.posix.basename(withoutExtension);
  if (basename === "index") {
    const directory = path.posix.dirname(withoutExtension);
    specifiers.add(directory);
    if (runtimeExtension !== null) specifiers.add(`${directory}${runtimeExtension}`);
  }
  return specifiers;
}

function pythonSpecifiers(sourceFile: string, targetFile: string): Set<string> {
  const specifiers = new Set<string>();
  const sourcePackage = path.posix.dirname(sourceFile).split("/").filter(Boolean);
  const extension = path.posix.extname(targetFile);
  let targetModule = extension === "" ? targetFile : targetFile.slice(0, -extension.length);
  if (targetModule.endsWith("/__init__")) targetModule = targetModule.slice(0, -"/__init__".length);
  const targetParts = targetModule.split("/").filter(Boolean);
  specifiers.add(targetParts.join("."));

  let common = 0;
  while (
    common < sourcePackage.length &&
    common < targetParts.length &&
    sourcePackage[common] === targetParts[common]
  ) {
    common += 1;
  }
  const upwardLevels = sourcePackage.length - common;
  const remainder = targetParts.slice(common).join(".");
  specifiers.add(`${".".repeat(upwardLevels + 1)}${remainder}`);
  if (remainder !== "") specifiers.add(remainder);
  return specifiers;
}

function possibleImportHashes(sourceFile: string, targetFile: string): Set<string> {
  const python = sourceFile.endsWith(".py") || sourceFile.endsWith(".pyi");
  return new Set(
    [...(python ? pythonSpecifiers(sourceFile, targetFile) : javascriptSpecifiers(sourceFile, targetFile))]
      .filter((specifier) => specifier !== "")
      .map((specifier) => sha256(`import:${specifier}`)),
  );
}

export function findUnresolvedImporters(
  database: AtlasDatabase,
  addedPaths: readonly string[],
): Set<string> {
  if (addedPaths.length === 0) return new Set();
  const issues = database
    .prepare(
      `SELECT file_path, reference_hash
       FROM resolution_issues
       WHERE reference_kind = 'import' AND reason = 'unresolved_reference'`,
    )
    .all() as ResolutionIssueRow[];
  const importers = new Set<string>();
  for (const issue of issues) {
    for (const addedPath of addedPaths) {
      if (possibleImportHashes(issue.file_path, addedPath).has(issue.reference_hash)) {
        importers.add(issue.file_path);
        break;
      }
    }
  }
  return importers;
}

function incomingDependencyFiles(
  database: AtlasDatabase,
  targetFiles: readonly string[],
): string[] {
  if (targetFiles.length === 0) return [];
  const result = new Set<string>();
  for (let offset = 0; offset < targetFiles.length; offset += 400) {
    const chunk = targetFiles.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(
        `SELECT DISTINCT source.file_path AS file_path
         FROM edges
         JOIN nodes source ON source.id = edges.source_node_id
         JOIN nodes target ON target.id = edges.target_node_id
         WHERE target.file_path IN (${placeholders})
           AND source.file_path IS NOT NULL
           AND edges.edge_type NOT IN (
             'CONTAINS', 'EXPORTS', 'RENAMED_FROM',
             'BELONGS_TO_FEATURE', 'BELONGS_TO_DOMAIN'
           )
         ORDER BY source.file_path`,
      )
      .all(...chunk) as Array<{ file_path: string }>;
    for (const row of rows) result.add(row.file_path);
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

export function findConsumersOfSymbols(
  database: AtlasDatabase,
  targetNodeIds: readonly string[],
): Set<string> {
  const result = new Set<string>();
  const uniqueIds = [...new Set(targetNodeIds)];
  for (let offset = 0; offset < uniqueIds.length; offset += 400) {
    const chunk = uniqueIds.slice(offset, offset + 400);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(
        `SELECT DISTINCT source.file_path AS file_path
         FROM edges
         JOIN nodes source ON source.id = edges.source_node_id
         WHERE edges.target_node_id IN (${placeholders})
           AND source.file_path IS NOT NULL
           AND edges.edge_type NOT IN (
             'CONTAINS', 'EXPORTS', 'RENAMED_FROM',
             'BELONGS_TO_FEATURE', 'BELONGS_TO_DOMAIN'
           )
         ORDER BY source.file_path`,
      )
      .all(...chunk) as Array<{ file_path: string }>;
    for (const row of rows) result.add(row.file_path);
  }
  return result;
}

export function findImportersOfFiles(
  database: AtlasDatabase,
  targetFiles: readonly string[],
): Set<string> {
  if (targetFiles.length === 0) return new Set();
  const result = new Set<string>();
  for (let offset = 0; offset < targetFiles.length; offset += 400) {
    const chunk = targetFiles.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(
        `SELECT DISTINCT source.file_path AS file_path
         FROM edges
         JOIN nodes source ON source.id = edges.source_node_id
         JOIN nodes target ON target.id = edges.target_node_id
         WHERE target.file_path IN (${placeholders})
           AND source.file_path IS NOT NULL
           AND edges.edge_type = 'IMPORTS'
         ORDER BY source.file_path`,
      )
      .all(...chunk) as Array<{ file_path: string }>;
    for (const row of rows) result.add(row.file_path);
  }
  return result;
}

export function findUnresolvedConsumersByName(
  database: AtlasDatabase,
  names: readonly string[],
): Set<string> {
  const uniqueNames = [...new Set(names)].filter((name) => name !== "");
  if (uniqueNames.length === 0) return new Set();
  const result = new Set<string>();
  for (let offset = 0; offset < uniqueNames.length; offset += 400) {
    const chunk = uniqueNames.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(
        `SELECT DISTINCT file_path
         FROM resolution_issues
         WHERE reference_name IN (${placeholders})
           AND reason = 'unresolved_reference'
         ORDER BY file_path`,
      )
      .all(...chunk) as Array<{ file_path: string }>;
    for (const row of rows) result.add(row.file_path);
  }
  return result;
}

export function findDependencyNeighborhood(
  database: AtlasDatabase,
  seedPaths: readonly string[],
  maxDepth: number,
  maxFiles: number,
): DependencyNeighborhoodResult {
  const visited = new Set(seedPaths);
  const dependents = new Set<string>();
  let frontier = [...new Set(seedPaths)];
  let depth = 0;
  let truncated = false;
  let reason: DependencyNeighborhoodResult["reason"] = null;
  for (; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    const incoming = incomingDependencyFiles(database, frontier);
    for (const filePath of incoming) {
      if (visited.has(filePath)) continue;
      if (dependents.size >= maxFiles) {
        truncated = true;
        reason = "max_files";
        break;
      }
      visited.add(filePath);
      dependents.add(filePath);
      next.push(filePath);
    }
    if (truncated) {
      frontier = next;
      break;
    }
    frontier = next;
  }

  if (!truncated && frontier.length > 0 && depth >= maxDepth) {
    const hasUnvisitedDependents = incomingDependencyFiles(database, frontier).some(
      (filePath) => !visited.has(filePath),
    );
    if (hasUnvisitedDependents) {
      truncated = true;
      reason = "max_depth";
    }
  }

  return {
    files: dependents,
    truncated,
    reason,
    visitedFiles: visited.size,
    frontierFiles: frontier.length,
  };
}

export interface DependencyNeighborhoodResult {
  files: Set<string>;
  truncated: boolean;
  reason: "max_depth" | "max_files" | null;
  visitedFiles: number;
  frontierFiles: number;
}
