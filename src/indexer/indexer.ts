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
import { createEdgeId, createNodeId } from "../graph/ids.js";
import { resolveReferences } from "../graph/resolver.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { RepositoryInfo } from "../git/repository.js";
import { detectRepository } from "../git/repository.js";
import type { ParsedFile } from "../parser/parser.js";
import {
  availableLanguageAdapters,
  getLanguageAdapter,
  TREE_SITTER_VERSION,
} from "../parser/registry.js";
import { openDatabase, removeDatabaseFiles, type AtlasDatabase } from "../storage/database.js";
import { clearContainmentEdges, upsertEdge } from "../storage/edges.js";
import { deleteFile, listFiles, upsertFile, type FileRecord } from "../storage/files.js";
import { clearDirectoryNodes, deleteNodesForFile, upsertNode } from "../storage/nodes.js";
import { getRepositoryState, setRepositoryStates } from "../storage/state.js";
import { CODEATLAS_VERSION, INDEXER_VERSION, SCHEMA_VERSION } from "../version.js";

export interface IndexOptions {
  startPath?: string;
  full?: boolean;
}

export interface IndexResult {
  repository: RepositoryInfo;
  fingerprint: string;
  files: number;
  changedFiles: number;
  deletedFiles: number;
  nodes: number;
  edges: number;
  symbols: number;
  parseErrors: number;
  languages: Record<string, number>;
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
}

function initialParseStatus(
  language: DetectedLanguage | null,
  enabled: { typescript: boolean; javascript: boolean; python: boolean },
  hasAdapter: boolean,
): string {
  if (language === null) return "unsupported";
  if (!isLanguageEnabled(language, enabled)) return "disabled";
  if (isSourceLanguage(language)) return hasAdapter ? "pending_parse" : "unsupported_parser";
  if (language !== null) return "metadata_only";
  return "unsupported";
}

function statusMatches(previous: string, current: string): boolean {
  if (current !== "pending_parse") return previous === current;
  return previous === "parsed" || previous === "parsed_with_errors" || previous === "parse_error";
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
        return {
          ...file,
          language,
          contentHash: await hashFile(file.absolutePath),
          parseStatus: initialParseStatus(language, config.languages, adapter !== null),
          adapterVersion: enabled && adapter !== null ? adapter.version : "none",
          parsedFile: null,
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
      const storedRoot = getRepositoryState(database, "repository_root");
      if (storedRoot !== null && storedRoot !== repository.root && !options.full) {
        throw new Error("Repository root changed; run `codeatlas index --full` to rebuild the index.");
      }

      const existing = new Map(listFiles(database).map((file) => [file.path, file]));
      const indexerChanged = getRepositoryState(database, "indexer_version") !== INDEXER_VERSION;
      const candidatePaths = new Set(candidates.map((file) => file.relativePath));
      const deleted = [...existing.keys()].filter((filePath) => !candidatePaths.has(filePath));
      const changed = candidates.filter((file) => {
        const previous = existing.get(file.relativePath);
        return (
          options.full === true ||
          indexerChanged ||
          previous === undefined ||
          previous.contentHash !== file.contentHash ||
          previous.language !== file.language ||
          !statusMatches(previous.parseStatus, file.parseStatus) ||
          previous.parserVersion !== (file.adapterVersion === "none" ? "none" : TREE_SITTER_VERSION) ||
          previous.adapterVersion !== file.adapterVersion
        );
      });
      await mapWithConcurrency(changed, 4, async (candidate) => {
        if (candidate.parseStatus !== "pending_parse") return;
        const adapter = getLanguageAdapter(candidate.language);
        if (adapter === null) {
          candidate.parseStatus = "unsupported_parser";
          return;
        }
        try {
          candidate.parsedFile = adapter.parseFile({
            repositoryId: repository.id,
            repositoryRoot: repository.root,
            relativeFilePath: candidate.relativePath,
            language: candidate.language ?? adapter.language,
            content: await readFile(candidate.absolutePath, "utf8"),
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
      });
      const indexedAt = new Date().toISOString();
      const configHash = sha256(JSON.stringify(config));
      const changedPaths = new Set(changed.map((candidate) => candidate.relativePath));

      const writeIndex = database.transaction(() => {
        if (options.full) {
          database.exec("DELETE FROM edges; DELETE FROM nodes; DELETE FROM files;");
        } else {
          for (const filePath of deleted) {
            deleteNodesForFile(database, filePath);
            deleteFile(database, filePath);
          }
        }

        for (const candidate of changed) {
          deleteNodesForFile(database, candidate.relativePath);
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
        clearContainmentEdges(database);
        clearDirectoryNodes(database);

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
        for (const directory of getDirectoryPaths(candidates)) {
          const id = createNodeId(repository.id, "directory", directory, directory);
          directoryNodeIds.set(directory, id);
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
          const parentId = parentDirectory === "." ? repositoryNodeId : directoryNodeIds.get(parentDirectory);
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

        for (const candidate of candidates) {
          const id = createNodeId(
            repository.id,
            "file",
            candidate.relativePath,
            candidate.relativePath,
          );
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
                },
              }),
              indexedAt,
            );
          }

          const parentDirectory = path.posix.dirname(candidate.relativePath);
          const parentId =
            parentDirectory === "." ? repositoryNodeId : directoryNodeIds.get(parentDirectory);
          if (parentId !== undefined) {
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
            (SELECT count(*) FROM files
              WHERE parse_status IN ('parsed_with_errors', 'parse_error')) AS parseErrors`,
        )
        .get() as { nodes: number; edges: number; symbols: number; parseErrors: number };
      const languages: Record<string, number> = {};
      for (const candidate of candidates) {
        if (candidate.language !== null) {
          languages[candidate.language] = (languages[candidate.language] ?? 0) + 1;
        }
      }

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
      });

      return {
        repository,
        fingerprint: fingerprint.fingerprint,
        files: candidates.length,
        changedFiles: changed.length,
        deletedFiles: deleted.length,
        nodes: counts.nodes,
        edges: counts.edges,
        symbols: counts.symbols,
        parseErrors: counts.parseErrors,
        languages,
        indexedAt,
      };
    } finally {
      database.close();
    }
  } finally {
    await releaseLock();
  }
}
