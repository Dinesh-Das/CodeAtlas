import { readFile } from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency } from "../core/async.js";
import { loadConfig } from "../core/config.js";
import { discoverFiles } from "../core/discovery.js";
import { computeRepositoryFingerprint } from "../core/freshness.js";
import { hashFile, sha256 } from "../core/hashing.js";
import { loadIgnoreRules } from "../core/ignore.js";
import {
  detectLanguage,
  isLanguageEnabled,
  isSourceLanguage,
  type DetectedLanguage,
} from "../core/languages.js";
import { acquireIndexLock, workspacePaths, writeJsonAtomic } from "../core/workspace.js";
import {
  availableFrameworkAdapters,
  extractFrameworkGraph,
  mergeFrameworkGraph,
  supportsFrameworkExtraction,
} from "../framework/registry.js";
import { createEdgeId, createNodeId } from "../graph/ids.js";
import {
  loadRenamePathAliases,
  planGraphRename,
  type RenamePlan,
} from "../graph/renames.js";
import { resolveReferences } from "../graph/resolver.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { RepositoryInfo } from "../git/repository.js";
import { detectRepository } from "../git/repository.js";
import { detectGitState } from "../git/changes.js";
import type { ParsedFile } from "../parser/parser.js";
import {
  availableLanguageAdapters,
  getLanguageAdapter,
  TREE_SITTER_VERSION,
} from "../parser/registry.js";
import { openDatabase, removeDatabaseFiles, type AtlasDatabase } from "../storage/database.js";
import { deleteEdgesForFile, upsertEdge } from "../storage/edges.js";
import { deleteFile, listFiles, upsertFile, type FileRecord } from "../storage/files.js";
import { deleteNodesById, deleteNodesForFile, upsertNode } from "../storage/nodes.js";
import { deleteResolutionIssuesForFile } from "../storage/resolution-issues.js";
import { getRepositoryState, setRepositoryStates } from "../storage/state.js";
import { CODEATLAS_VERSION, INDEXER_VERSION, SCHEMA_VERSION } from "../version.js";
import { classifyRepositoryChanges } from "./changes.js";
import {
  findDependencyNeighborhood,
  findUnresolvedImporters,
} from "./invalidation.js";

export interface IndexOptions {
  startPath?: string;
  full?: boolean;
}

export interface IndexResult {
  repository: RepositoryInfo;
  fingerprint: string;
  files: number;
  changedFiles: number;
  addedFiles: number;
  modifiedFiles: number;
  deletedFiles: number;
  renamedFiles: number;
  invalidatedFiles: number;
  fullRebuild: boolean;
  dirtyWorkingTree: boolean;
  nodes: number;
  edges: number;
  symbols: number;
  parseErrors: number;
  apiRoutes: number;
  databaseModels: number;
  languages: Record<string, number>;
  frameworks: string[];
  indexedAt: string;
}

interface IndexedCandidate {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  language: DetectedLanguage | null;
  contentHash: string;
  parseStatus: string;
  adapterVersion: string;
  parsedFile: ParsedFile | null;
  detectedFrameworks: string[];
}

function initialParseStatus(
  language: DetectedLanguage | null,
  enabled: { typescript: boolean; javascript: boolean; python: boolean },
  hasAdapter: boolean,
  hasFrameworkAdapter: boolean,
): string {
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
  if (language !== null) return "metadata_only";
  return "unsupported";
}

function statusMatches(previous: string, current: string): boolean {
  if (current === "pending_parse") {
    return (
      previous === "parsed" ||
      previous === "parsed_with_errors" ||
      previous === "parse_error"
    );
  }
  if (current === "pending_framework") {
    return previous === "parsed" || previous === "metadata_only" || previous === "parse_error";
  }
  return previous === current;
}

function graphNode(input: Partial<GraphNode> & Pick<GraphNode, "id" | "kind" | "name">): GraphNode {
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
    confidence: 1,
    metadata: {},
    ...input,
  };
}

function graphEdge(
  input: Partial<GraphEdge> &
    Pick<GraphEdge, "id" | "sourceNodeId" | "targetNodeId" | "edgeType">,
): GraphEdge {
  return {
    sourceType: "git",
    confidence: 1,
    filePath: null,
    line: null,
    metadata: {},
    ...input,
  };
}

function getDirectoryPaths(files: readonly IndexedCandidate[]): string[] {
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

async function readCreatedAt(manifestPath: string, fallback: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { createdAt?: unknown };
    return typeof manifest.createdAt === "string" ? manifest.createdAt : fallback;
  } catch {
    return fallback;
  }
}

export async function runIndex(options: IndexOptions = {}): Promise<IndexResult> {
  const repository = await detectRepository(options.startPath);
  const paths = workspacePaths(repository.root);
  const config = await loadConfig(repository.root);
  const releaseLock = await acquireIndexLock(repository.root);

  try {
    const ignoreRules = await loadIgnoreRules(repository.root);
    const discovered = await discoverFiles(repository.root, ignoreRules);
    const candidates: IndexedCandidate[] = await mapWithConcurrency(
      discovered,
      32,
      async (file) => {
        const language = detectLanguage(file.relativePath);
        const adapter = getLanguageAdapter(language);
        const enabled = isLanguageEnabled(language, config.languages);
        const frameworkSupported =
          config.analysis.frameworks &&
          supportsFrameworkExtraction(file.relativePath, language);
        return {
          ...file,
          language,
          contentHash: await hashFile(file.absolutePath),
          parseStatus: initialParseStatus(
            language,
            config.languages,
            adapter !== null,
            frameworkSupported,
          ),
          adapterVersion: enabled && adapter !== null ? adapter.version : "none",
          parsedFile: null,
          detectedFrameworks: [],
        };
      },
    );
    candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    const fingerprint = await computeRepositoryFingerprint(repository, candidates, ignoreRules);
    let database: AtlasDatabase;
    try {
      database = openDatabase(paths.database);
    } catch (error) {
      if (!options.full) {
        throw new Error(
          "The CodeAtlas database could not be opened. Run `codeatlas doctor`, then `codeatlas index --full` to rebuild it.",
          { cause: error },
        );
      }
      await removeDatabaseFiles(paths.database);
      database = openDatabase(paths.database);
    }

    try {
      const existing = new Map(listFiles(database).map((file) => [file.path, file]));
      const currentByPath = new Map(
        candidates.map((candidate) => [candidate.relativePath, candidate]),
      );
      const storedRoot = getRepositoryState(database, "repository_root");
      const storedCommit = getRepositoryState(database, "last_indexed_commit");
      const configHash = sha256(JSON.stringify(config));
      const gitState = await detectGitState(repository.root, storedCommit, repository.headCommit);
      const indexerChanged = getRepositoryState(database, "indexer_version") !== INDEXER_VERSION;
      const schemaChanged =
        getRepositoryState(database, "schema_version") !== String(SCHEMA_VERSION);
      const parserChanged = [...existing.values()].some((previous) => {
        const current = currentByPath.get(previous.path);
        if (current === undefined) return false;
        const parserVersion =
          current.adapterVersion === "none" ? "none" : TREE_SITTER_VERSION;
        return (
          previous.parserVersion !== parserVersion ||
          previous.adapterVersion !== current.adapterVersion
        );
      });
      const storedConfigHash = getRepositoryState(database, "config_hash");
      const configChanged = storedConfigHash !== null && storedConfigHash !== configHash;
      const fullRebuild =
        options.full === true ||
        schemaChanged ||
        parserChanged ||
        indexerChanged ||
        configChanged ||
        (storedRoot !== null && storedRoot !== repository.root) ||
        !gitState.historyConsistent;
      const changes = classifyRepositoryChanges(
        new Set(existing.keys()),
        candidates,
        gitState,
        (candidate) => candidate.relativePath,
        (file) => {
          const previous = existing.get(file.relativePath);
          return (
            previous === undefined ||
            previous.contentHash !== file.contentHash ||
            previous.language !== file.language ||
            !statusMatches(previous.parseStatus, file.parseStatus) ||
            previous.parserVersion !==
              (file.adapterVersion === "none" ? "none" : TREE_SITTER_VERSION) ||
            previous.adapterVersion !== file.adapterVersion
          );
        },
        loadRenamePathAliases(database),
      );
      const directlyChangedPaths = new Set([
        ...changes.added.map((candidate) => candidate.relativePath),
        ...changes.modified.map((candidate) => candidate.relativePath),
        ...changes.renamed.map((rename) => rename.path),
      ]);
      const unresolvedImporters = fullRebuild
        ? new Set<string>()
        : findUnresolvedImporters(database, [
            ...changes.added.map((candidate) => candidate.relativePath),
            ...changes.renamed.map((rename) => rename.path),
          ]);
      const dependencySeeds = [
        ...changes.modified.map((candidate) => candidate.relativePath),
        ...changes.deleted,
        ...changes.renamed.map((rename) => rename.previousPath),
        ...unresolvedImporters,
      ];
      const dependencyNeighborhood = fullRebuild
        ? new Set<string>()
        : findDependencyNeighborhood(
            database,
            dependencySeeds,
            config.limits.maxTraversalDepth,
          );
      const invalidatedPaths = new Set(
        [...unresolvedImporters, ...dependencyNeighborhood].filter(
          (filePath) =>
            currentByPath.has(filePath) && !directlyChangedPaths.has(filePath),
        ),
      );
      const changed = fullRebuild
        ? candidates
        : candidates.filter(
            (candidate) =>
              directlyChangedPaths.has(candidate.relativePath) ||
              invalidatedPaths.has(candidate.relativePath),
          );
      await mapWithConcurrency(changed, 4, async (candidate) => {
        let content: string | null = null;
        if (candidate.parseStatus === "pending_parse") {
          const adapter = getLanguageAdapter(candidate.language);
          if (adapter === null) {
            candidate.parseStatus = "unsupported_parser";
          } else {
            try {
              content = await readFile(candidate.absolutePath, "utf8");
              candidate.parsedFile = adapter.parseFile({
                repositoryId: repository.id,
                repositoryRoot: repository.root,
                relativeFilePath: candidate.relativePath,
                language: candidate.language ?? adapter.language,
                content,
                contentHash: candidate.contentHash,
              });
              candidate.parseStatus = candidate.parsedFile.errors.some(
                (diagnostic) => diagnostic.severity === "error",
              )
                ? "parsed_with_errors"
                : "parsed";
            } catch {
              candidate.parsedFile = null;
              candidate.parseStatus = "parse_error";
            }
          }
        }

        const frameworkSupported =
          config.analysis.frameworks &&
          supportsFrameworkExtraction(candidate.relativePath, candidate.language) &&
          (candidate.language === null ||
            isLanguageEnabled(candidate.language, config.languages));
        if (frameworkSupported) {
          content ??= await readFile(candidate.absolutePath, "utf8");
          const extraction = extractFrameworkGraph({
            repositoryId: repository.id,
            repositoryRoot: repository.root,
            relativeFilePath: candidate.relativePath,
            language: candidate.language,
            content,
            contentHash: candidate.contentHash,
            parsedFile: candidate.parsedFile,
          });
          candidate.detectedFrameworks = extraction.detectedFrameworks;
          candidate.parsedFile = mergeFrameworkGraph(candidate.parsedFile, extraction);
          if (candidate.parseStatus === "pending_framework") {
            candidate.parseStatus = candidate.parsedFile === null ? "metadata_only" : "parsed";
          }
        }
      });
      const renamePlans = new Map<string, RenamePlan>();
      if (!fullRebuild) {
        for (const rename of changes.renamed) {
          const parsedFile = rename.current.parsedFile ?? {
            nodes: [],
            edges: [],
            unresolvedReferences: [],
            errors: [],
          };
          const plan = planGraphRename(
            database,
            repository.id,
            rename.previousPath,
            rename.path,
            rename.similarity,
            parsedFile,
          );
          renamePlans.set(rename.path, plan);
          if (rename.current.parsedFile !== null) rename.current.parsedFile = plan.parsedFile;
        }
      }
      const indexedAt = new Date().toISOString();
      const changedPaths = new Set(changed.map((candidate) => candidate.relativePath));
      const directoryPaths = getDirectoryPaths(candidates);
      const currentDirectoryPaths = new Set(directoryPaths);
      const existingDirectoryPaths = new Set(
        (
          database
            .prepare(
              "SELECT file_path FROM nodes WHERE kind = 'directory' AND file_path IS NOT NULL",
            )
            .all() as Array<{ file_path: string }>
        ).map((row) => row.file_path),
      );
      const directoriesToWrite = fullRebuild
        ? directoryPaths
        : directoryPaths.filter((directory) => !existingDirectoryPaths.has(directory));
      const removedDirectoryNodeIds = fullRebuild
        ? []
        : [...existingDirectoryPaths]
            .filter((directory) => !currentDirectoryPaths.has(directory))
            .map((directory) =>
              createNodeId(repository.id, "directory", directory, directory),
            );

      const writeIndex = database.transaction(() => {
        if (fullRebuild) {
          database.exec("DELETE FROM edges; DELETE FROM nodes; DELETE FROM files;");
        } else {
          for (const filePath of changes.deleted) {
            deleteNodesForFile(database, filePath);
            deleteFile(database, filePath);
          }
          for (const plan of renamePlans.values()) {
            deleteEdgesForFile(database, plan.previousPath);
            deleteResolutionIssuesForFile(database, plan.previousPath);
            deleteNodesById(database, plan.removedNodeIds);
            deleteFile(database, plan.previousPath);
          }
          deleteNodesById(database, removedDirectoryNodeIds);
        }

        for (const candidate of changed) {
          if (!renamePlans.has(candidate.relativePath)) {
            deleteNodesForFile(database, candidate.relativePath);
          }
          const record: FileRecord = {
            path: candidate.relativePath,
            language: candidate.language,
            contentHash: candidate.contentHash,
            sizeBytes: candidate.sizeBytes,
            parserVersion: candidate.adapterVersion === "none" ? "none" : TREE_SITTER_VERSION,
            adapterVersion: candidate.adapterVersion,
            indexedCommit: repository.headCommit,
            parseStatus: candidate.parseStatus,
            indexedAt,
          };
          upsertFile(database, record);
        }

        database.prepare("UPDATE files SET indexed_commit = ?").run(repository.headCommit);

        const repositoryNodeId = createNodeId(repository.id, "repository", ".", repository.name);
        upsertNode(
          database,
          graphNode({
            id: repositoryNodeId,
            kind: "repository",
            name: repository.name,
            qualifiedName: repository.name,
            metadata: { branch: repository.branch, headCommit: repository.headCommit },
          }),
          indexedAt,
        );

        const directoryNodeIds = new Map<string, string>();
        for (const directory of directoryPaths) {
          const id = createNodeId(repository.id, "directory", directory, directory);
          directoryNodeIds.set(directory, id);
        }
        for (const directory of directoriesToWrite) {
          const id = directoryNodeIds.get(directory)!;
          upsertNode(
            database,
            graphNode({
              id,
              kind: "directory",
              name: path.posix.basename(directory),
              qualifiedName: directory,
              filePath: directory,
            }),
            indexedAt,
          );

          const parentDirectory = path.posix.dirname(directory);
          const parentId =
            parentDirectory === "."
              ? repositoryNodeId
              : directoryNodeIds.get(parentDirectory);
          if (parentId !== undefined) {
            upsertEdge(
              database,
              graphEdge({
                id: createEdgeId(repository.id, "CONTAINS", parentId, id, directory),
                sourceNodeId: parentId,
                targetNodeId: id,
                edgeType: "CONTAINS",
                filePath: directory,
              }),
              indexedAt,
            );
          }
        }

        const fileNodeIds = new Map(
          candidates.map((candidate) => [
            candidate.relativePath,
            renamePlans.get(candidate.relativePath)?.fileNodeId ??
              createNodeId(
                repository.id,
                "file",
                candidate.relativePath,
                candidate.relativePath,
              ),
          ]),
        );
        for (const candidate of candidates) {
          const id = fileNodeIds.get(candidate.relativePath)!;
          if (changedPaths.has(candidate.relativePath)) {
            upsertNode(
              database,
              graphNode({
                id,
                kind: "file",
                name: path.posix.basename(candidate.relativePath),
                qualifiedName: candidate.relativePath,
                filePath: candidate.relativePath,
                language: candidate.language,
                contentHash: candidate.contentHash,
                metadata: {
                  parseStatus: candidate.parseStatus,
                  sizeBytes: candidate.sizeBytes,
                  diagnosticCount: candidate.parsedFile?.errors.length ?? 0,
                  unresolvedReferenceCount: candidate.parsedFile?.unresolvedReferences.length ?? 0,
                  frameworks: candidate.detectedFrameworks,
                },
              }),
              indexedAt,
            );
          }

          const parentDirectory = path.posix.dirname(candidate.relativePath);
          const parentId =
            parentDirectory === "." ? repositoryNodeId : directoryNodeIds.get(parentDirectory);
          if (parentId !== undefined && changedPaths.has(candidate.relativePath)) {
            upsertEdge(
              database,
              graphEdge({
                id: createEdgeId(
                  repository.id,
                  "CONTAINS",
                  parentId,
                  id,
                  candidate.relativePath,
                ),
                sourceNodeId: parentId,
                targetNodeId: id,
                edgeType: "CONTAINS",
                filePath: candidate.relativePath,
              }),
              indexedAt,
            );
          }
        }

        for (const candidate of changed) {
          if (candidate.parsedFile === null) continue;
          for (const node of candidate.parsedFile.nodes) upsertNode(database, node, indexedAt);
          for (const edge of candidate.parsedFile.edges) upsertEdge(database, edge, indexedAt);
        }
        for (const plan of renamePlans.values()) {
          for (const edge of plan.renameEdges) upsertEdge(database, edge, indexedAt);
        }

        resolveReferences(
          database,
          repository.id,
          changed.flatMap((candidate) =>
            candidate.parsedFile === null
              ? []
              : [{ relativePath: candidate.relativePath, parsedFile: candidate.parsedFile }],
          ),
          indexedAt,
        );

        setRepositoryStates(database, {
          schema_version: String(SCHEMA_VERSION),
          codeatlas_version: CODEATLAS_VERSION,
          indexer_version: INDEXER_VERSION,
          last_indexed_commit: repository.headCommit,
          last_indexed_at: indexedAt,
          repository_root: repository.root,
          repository_id: repository.id,
          dirty_fingerprint: fingerprint.fingerprint,
          config_hash: configHash,
          working_tree_dirty: String(gitState.dirty),
          last_change_summary: JSON.stringify({
            added: changes.added.map((candidate) => candidate.relativePath),
            modified: changes.modified.map((candidate) => candidate.relativePath),
            deleted: changes.deleted,
            renamed: changes.renamed.map((rename) => ({
              from: rename.previousPath,
              to: rename.path,
              similarity: rename.similarity,
            })),
            invalidated: [...invalidatedPaths].sort((left, right) => left.localeCompare(right)),
            fullRebuild,
          }),
        });
      });
      writeIndex();

      const counts = database
        .prepare(
          `SELECT
            (SELECT count(*) FROM nodes) AS nodes,
            (SELECT count(*) FROM edges) AS edges,
            (SELECT count(*) FROM nodes
              WHERE kind NOT IN ('repository', 'directory', 'file', 'module')) AS symbols,
            (SELECT count(*) FROM nodes WHERE kind = 'api_route') AS apiRoutes,
            (SELECT count(*) FROM nodes WHERE kind = 'database_model') AS databaseModels,
            (SELECT count(*) FROM files
              WHERE parse_status IN ('parsed_with_errors', 'parse_error')) AS parseErrors`,
        )
        .get() as {
          nodes: number;
          edges: number;
          symbols: number;
          apiRoutes: number;
          databaseModels: number;
          parseErrors: number;
        };
      const languages: Record<string, number> = {};
      for (const candidate of candidates) {
        if (candidate.language !== null) {
          languages[candidate.language] = (languages[candidate.language] ?? 0) + 1;
        }
      }
      const frameworks = (
        database
          .prepare(
            `SELECT DISTINCT json_extract(metadata_json, '$.framework') AS framework
             FROM nodes
             WHERE kind IN ('api_route', 'database_model')
               AND json_extract(metadata_json, '$.framework') IS NOT NULL
             ORDER BY framework`,
          )
          .all() as Array<{ framework: string }>
      ).map((row) => row.framework);

      const createdAt = await readCreatedAt(paths.manifest, indexedAt);
      await writeJsonAtomic(paths.manifest, {
        version: 1,
        repositoryId: repository.id,
        repositoryRoot: repository.root,
        codeatlasVersion: CODEATLAS_VERSION,
        schemaVersion: SCHEMA_VERSION,
        parserVersion: TREE_SITTER_VERSION,
        adapters: Object.fromEntries(
          availableLanguageAdapters().map((adapter) => [adapter.language, adapter.version]),
        ),
        frameworks,
        frameworkAdapters: Object.fromEntries(
          availableFrameworkAdapters().map((adapter) => [adapter.name, adapter.version]),
        ),
        createdAt,
        updatedAt: indexedAt,
        languages,
      });
      await writeJsonAtomic(paths.state, {
        version: 1,
        fingerprint: fingerprint.fingerprint,
        headCommit: repository.headCommit,
        branch: repository.branch,
        indexedAt,
        files: candidates.length,
        nodes: counts.nodes,
        edges: counts.edges,
        symbols: counts.symbols,
        parseErrors: counts.parseErrors,
        apiRoutes: counts.apiRoutes,
        databaseModels: counts.databaseModels,
        changes: {
          updated: changed.length,
          added: changes.added.length,
          modified: changes.modified.length,
          deleted: changes.deleted.length,
          renamed: changes.renamed.length,
          invalidated: invalidatedPaths.size,
          fullRebuild,
          dirtyWorkingTree: gitState.dirty,
        },
      });

      return {
        repository,
        fingerprint: fingerprint.fingerprint,
        files: candidates.length,
        changedFiles: changed.length,
        addedFiles: changes.added.length,
        modifiedFiles: changes.modified.length,
        deletedFiles: changes.deleted.length,
        renamedFiles: changes.renamed.length,
        invalidatedFiles: invalidatedPaths.size,
        fullRebuild,
        dirtyWorkingTree: gitState.dirty,
        nodes: counts.nodes,
        edges: counts.edges,
        symbols: counts.symbols,
        parseErrors: counts.parseErrors,
        apiRoutes: counts.apiRoutes,
        databaseModels: counts.databaseModels,
        languages,
        frameworks,
        indexedAt,
      };
    } finally {
      database.close();
    }
  } finally {
    await releaseLock();
  }
}
