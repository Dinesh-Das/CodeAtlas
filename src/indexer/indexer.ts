import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runArchitectureAnalysis } from "../analysis/architecture.js";
import {
  mergeArchitecturalIntent,
  supportsArchitecturalIntent,
} from "../analysis/intent.js";
import type { ArchitectureAnalysisResult } from "../analysis/types.js";
import { mapWithConcurrency } from "../core/async.js";
import { loadConfig } from "../core/config.js";
import { discoverFiles, type DiscoveredFile } from "../core/discovery.js";
import {
  computeWorktreeSignature,
  repositoryFingerprintFromWorktree,
  type WorktreeSignature,
} from "../core/freshness.js";
import { hashFile, sha256 } from "../core/hashing.js";
import { loadIgnoreRules, type IgnoreRules } from "../core/ignore.js";
import {
  IndexTelemetry,
  type IndexPhaseMetric,
  type IndexProgress,
} from "../core/telemetry.js";
import {
  detectLanguage,
  isLanguageEnabled,
  isSourceLanguage,
  type DetectedLanguage,
} from "../core/languages.js";
import { acquireIndexLock, workspacePaths, writeJsonAtomic } from "../core/workspace.js";
import { workspaceManifestPaths } from "../core/workspace-packages.js";
import {
  availableFrameworkAdapters,
  extractFrameworkGraph,
  mergeFrameworkGraph,
  supportsFrameworkExtraction,
} from "../framework/registry.js";
import { materializeFrameworkRelationships } from "../framework/materialize.js";
import { createEdgeId, createNodeId } from "../graph/ids.js";
import {
  loadRenamePathAliases,
  planGraphRename,
  type RenamePlan,
} from "../graph/renames.js";
import { resolveReferences, type ResolutionResult } from "../graph/resolver.js";
import {
  TypeScriptProjectResolver,
  type CompilerPublicApiFacts,
} from "../graph/typescript-resolution.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { RepositoryInfo } from "../git/repository.js";
import { detectRepository } from "../git/repository.js";
import { detectGitState, type GitState } from "../git/changes.js";
import { collectRecentFileHistory } from "../git/history.js";
import type { ParsedFile } from "../parser/parser.js";
import {
  availableLanguageAdapters,
  getLanguageAdapter,
  TREE_SITTER_VERSION,
} from "../parser/registry.js";
import { openDatabase, removeDatabaseFiles, type AtlasDatabase } from "../storage/database.js";
import {
  deleteEdgesForFile,
  refreshArchitectureEdgeLocationsForFiles,
  upsertEdge,
} from "../storage/edges.js";
import { deleteFile, listFiles, upsertFile, type FileRecord } from "../storage/files.js";
import {
  observeNodeSearchMutations,
  rebuildNodeSearch,
  suspendNodeSearchSync,
} from "../storage/fts.js";
import { loadGitHistoryCache, replaceGitHistoryCache } from "../storage/git-history.js";
import {
  deleteNodesById,
  deleteNodesForFile,
  deleteStaleNodesForFile,
  upsertNode,
} from "../storage/nodes.js";
import { deleteResolutionIssuesForFile } from "../storage/resolution-issues.js";
import {
  generationsFromState,
  getRepositoryState,
  getRepositoryStates,
  nextStructuralGeneration,
  setRepositoryStates,
  type RepositoryGenerations,
} from "../storage/state.js";
import {
  deleteExtractedEdgesForFile,
  deleteFileSemanticFacts,
  deleteResolvedEdgesForFiles,
  getFileSemanticFactsForPaths,
  listFileSemanticFactPaths,
  upsertFileSemanticFacts,
} from "../storage/semantic.js";
import { CODEATLAS_VERSION, INDEXER_VERSION, SCHEMA_VERSION } from "../version.js";
import { classifyRepositoryChanges } from "./changes.js";
import {
  findConsumersOfSymbols,
  findImportersOfFiles,
  findUnresolvedImporters,
  findUnresolvedConsumersByName,
} from "./invalidation.js";
import {
  buildFileSemanticFacts,
  classifySemanticDelta,
  isModuleResolutionConfiguration,
  type FileSemanticFacts,
  type SemanticChangeClass,
  type SemanticDelta,
} from "./semantic-delta.js";

export interface IndexOptions {
  startPath?: string;
  full?: boolean;
  /** Integration hook for verifying crash recovery after the structural commit boundary. */
  afterStructuralCommit?: () => void;
  onProgress?: (progress: IndexProgress) => void;
  /** Reuses the already-authoritative fast freshness pass from indexRepository. */
  precomputedRepository?: RepositoryInfo;
  precomputedWorktree?: WorktreeSignature;
  precomputedIgnoreRules?: IgnoreRules;
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
  invalidationTruncated: boolean;
  invalidationTruncationReason: "max_depth" | "max_files" | null;
  fullRebuild: boolean;
  dirtyWorkingTree: boolean;
  nodes: number;
  edges: number;
  symbols: number;
  parseErrors: number;
  apiRoutes: number;
  databaseModels: number;
  features: number;
  domains: number;
  communities: number;
  cycles: number;
  hotspots: number;
  findings: number;
  languages: Record<string, number>;
  frameworks: string[];
  indexedAt: string;
  generations: RepositoryGenerations;
  semanticChanges: Record<SemanticChangeClass, number>;
  work: {
    filesRead: number;
    filesParsed: number;
    filesSemanticallyAnalyzed: number;
    dependentFilesInvalidated: number;
    symbolsRewritten: number;
    referencesRewritten: number;
    candidateCount: number;
    resolvedEdgeCount: number;
    sqliteMutations: number;
    ftsMutations: number;
    architectureFiles: number;
  };
  phaseMetrics: IndexPhaseMetric[];
  peakRssBytes: number;
  timingsMs: {
    discovery: number;
    fingerprint: number;
    parsing: number;
    persistence: number;
    architecture: number;
    total: number;
  };
}

interface IndexedCandidate {
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

interface WorkspacePackage {
  directory: string;
  manifestPath: string;
  name: string;
  version: string | null;
  isPrivate: boolean;
  dependencies: string[];
  hasExports: boolean;
}

async function loadWorkspacePackages(
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

function owningPackage(
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

function initialParseStatus(
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
  if (current === "pending_intent") return previous === "parsed_intent";
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
    provenance: "git",
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
    provenance: "git",
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

async function discoverFromManifest(
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

export async function runIndex(options: IndexOptions = {}): Promise<IndexResult> {
  const indexStartedAt = performance.now();
  const telemetry = new IndexTelemetry(options.onProgress);
  const repository = options.precomputedRepository ?? await detectRepository(options.startPath);
  const paths = workspacePaths(repository.root);
  telemetry.start("ignore_config_loading");
  const config = await loadConfig(repository.root);
  const ignoreRules = options.precomputedIgnoreRules ?? await loadIgnoreRules(repository.root);
  telemetry.end("ignore_config_loading", { itemsProcessed: 1 });
  let waitingForLock = false;
  const releaseLock = await acquireIndexLock(repository.root, {
    onWait: () => {
      if (!waitingForLock) {
        waitingForLock = true;
        telemetry.start("index_lock_wait");
      }
      telemetry.progress("index_lock_wait", 0, null);
    },
  });
  if (waitingForLock) telemetry.end("index_lock_wait");

  try {
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
      const storedState = getRepositoryStates(database);
      const existing = new Map(listFiles(database).map((file) => [file.path, file]));
      const storedCommit = storedState.last_indexed_commit ?? null;
      let gitFreshnessWorkMs = 0;
      let gitStartedAt = performance.now();
      const gitStatePromise = repository.gitAvailable
        ? detectGitState(
            repository.root,
            storedCommit,
            repository.headCommit,
            options.precomputedWorktree?.statusOutput,
          )
        : Promise.resolve<GitState>({
            dirty: false,
            historyConsistent: true,
            changes: [],
            renames: [],
          });
      const [gitState, worktree] = await Promise.all([
        gitStatePromise,
        options.precomputedWorktree === undefined
          ? computeWorktreeSignature(repository, ignoreRules)
          : Promise.resolve(options.precomputedWorktree),
      ]);
      gitFreshnessWorkMs += performance.now() - gitStartedAt;
      const pathAliases = loadRenamePathAliases(database);
      let previousWorktreePaths: string[] = [];
      try {
        const parsed = JSON.parse(storedState.worktree_changed_paths ?? "[]") as unknown;
        if (Array.isArray(parsed)) {
          previousWorktreePaths = parsed.filter((entry): entry is string => typeof entry === "string");
        }
      } catch {
        previousWorktreePaths = [];
      }
      const gitChangedPaths = new Set(
        [
          ...previousWorktreePaths,
          ...worktree.changedPaths,
          ...gitState.changes.flatMap((change) => [
            change.path,
            ...(change.previousPath === null
              ? []
              : [pathAliases.get(change.previousPath) ?? change.previousPath]),
          ]),
        ],
      );
      const storedRoot = getRepositoryState(database, "repository_root");
      const contractAllowsManifest =
        repository.gitAvailable &&
        options.full !== true &&
        existing.size > 0 &&
        storedState.schema_version === String(SCHEMA_VERSION) &&
        storedState.indexer_version === INDEXER_VERSION &&
        (storedRoot === null || storedRoot === repository.root) &&
        gitState.historyConsistent &&
        (gitChangedPaths.size > 0 || storedState.worktree_signature === worktree.signature);
      const discoveryStartedAt = performance.now();
      telemetry.start("repository_discovery");
      const discovered = contractAllowsManifest
        ? await discoverFromManifest(repository.root, existing, gitChangedPaths, ignoreRules)
        : await discoverFiles(repository.root, ignoreRules);
      const discoveryMs = performance.now() - discoveryStartedAt;
      telemetry.end("repository_discovery", {
        itemsProcessed: contractAllowsManifest ? gitChangedPaths.size : discovered.length,
        itemsSkipped: contractAllowsManifest ? Math.max(0, discovered.length - gitChangedPaths.size) : 0,
        cacheHits: contractAllowsManifest ? Math.max(0, discovered.length - gitChangedPaths.size) : 0,
      });
      const fingerprintStartedAt = performance.now();
      telemetry.start("fingerprinting", discovered.length);
      let fingerprintReadWorkMs = 0;
      let fingerprintCacheHits = 0;
      let fingerprintCacheMisses = 0;
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
          const intentSupported = supportsArchitecturalIntent(file.relativePath, language);
          const previous = existing.get(file.relativePath);
          const unchangedStat =
            previous !== undefined &&
            previous.sizeBytes === file.sizeBytes &&
            previous.mtimeMs === file.mtimeMs &&
            previous.ctimeMs === file.ctimeMs;
          let contentHash: string;
          let initialContent: string | null = null;
          if (unchangedStat) {
            fingerprintCacheHits += 1;
            contentHash = previous.contentHash;
          } else {
            fingerprintCacheMisses += 1;
            const readStartedAt = performance.now();
            if (contractAllowsManifest) {
              initialContent = await readFile(file.absolutePath, "utf8");
              contentHash = sha256(initialContent);
            } else {
              contentHash = await hashFile(file.absolutePath);
            }
            fingerprintReadWorkMs += performance.now() - readStartedAt;
          }
          return {
            ...file,
            language,
            contentHash,
            parseStatus: initialParseStatus(
              language,
              config.languages,
              adapter !== null,
              frameworkSupported,
              intentSupported,
            ),
            adapterVersion: enabled && adapter !== null ? adapter.version : "none",
            parsedFile: null,
            content: initialContent,
            semanticFacts: null,
            detectedFrameworks: [],
          };
        },
      );
      candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      const workspacePackages = await loadWorkspacePackages(candidates, repository.root);

      gitStartedAt = performance.now();
      const fingerprint = repositoryFingerprintFromWorktree(repository, candidates, worktree);
      gitFreshnessWorkMs += performance.now() - gitStartedAt;
      const fingerprintMs = performance.now() - fingerprintStartedAt;
      telemetry.end("fingerprinting", {
        itemsProcessed: candidates.length,
        cacheHits: fingerprintCacheHits,
        cacheMisses: fingerprintCacheMisses,
        workMs: fingerprintReadWorkMs,
      });
      telemetry.record("git_status_freshness", gitFreshnessWorkMs, {
        itemsProcessed: gitState.changes.length,
      });
      const currentByPath = new Map(
        candidates.map((candidate) => [candidate.relativePath, candidate]),
      );
      const configHash = sha256(JSON.stringify(config));
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
      let fullRebuild =
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
        pathAliases,
      );
      const directlyChangedPaths = new Set([
        ...changes.added.map((candidate) => candidate.relativePath),
        ...changes.modified.map((candidate) => candidate.relativePath),
        ...changes.renamed.map((rename) => rename.path),
      ]);
      const moduleConfigurationChanged = [
        ...changes.added.map((candidate) => candidate.relativePath),
        ...changes.modified.map((candidate) => candidate.relativePath),
        ...changes.deleted,
        ...changes.renamed.flatMap((rename) => [rename.previousPath, rename.path]),
      ].some(isModuleResolutionConfiguration);
      let invalidationTruncated = false;
      let invalidationTruncationReason: "max_depth" | "max_files" | null = null;
      if (
        !fullRebuild &&
        moduleConfigurationChanged &&
        existing.size - directlyChangedPaths.size > config.limits.maxInvalidationFiles
      ) {
        fullRebuild = true;
        invalidationTruncated = true;
        invalidationTruncationReason = "max_files";
      }
      const unresolvedImporters = fullRebuild
        ? new Set<string>()
        : findUnresolvedImporters(database, [
            ...changes.added.map((candidate) => candidate.relativePath),
            ...changes.renamed.map((rename) => rename.path),
          ]);
      const changed = fullRebuild
        ? candidates
        : candidates.filter((candidate) => directlyChangedPaths.has(candidate.relativePath));
      const parsingStartedAt = performance.now();
      telemetry.start("tree_sitter_parsing", changed.length);
      let processedCandidates = 0;
      let parsedItems = 0;
      let parsedSymbolCount = 0;
      let parsedReferenceCount = 0;
      let parsingReadWorkMs = 0;
      let parsingReadCount = 0;
      let parserWorkMs = 0;
      await mapWithConcurrency(changed, 4, async (candidate) => {
        let content: string | null = candidate.content;
        const loadContent = async (): Promise<string> => {
          if (content !== null) return content;
          const readStartedAt = performance.now();
          content = await readFile(candidate.absolutePath, "utf8");
          parsingReadWorkMs += performance.now() - readStartedAt;
          parsingReadCount += 1;
          candidate.content = content;
          return content;
        };
        if (candidate.parseStatus === "pending_parse") {
          const adapter = getLanguageAdapter(candidate.language);
          if (adapter === null) {
            candidate.parseStatus = "unsupported_parser";
          } else {
            try {
              content = await loadContent();
              const parserStartedAt = performance.now();
              candidate.parsedFile = adapter.parseFile({
                repositoryId: repository.id,
                repositoryRoot: repository.root,
                relativeFilePath: candidate.relativePath,
                language: candidate.language ?? adapter.language,
                content,
                contentHash: candidate.contentHash,
              });
              parsedItems += 1;
              parserWorkMs += performance.now() - parserStartedAt;
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
          content = await loadContent();
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


        const intentSupported =
          supportsArchitecturalIntent(candidate.relativePath, candidate.language) &&
          (candidate.language === null ||
            isLanguageEnabled(candidate.language, config.languages));
        if (intentSupported) {
          content = await loadContent();
          candidate.parsedFile = mergeArchitecturalIntent({
            repositoryId: repository.id,
            relativeFilePath: candidate.relativePath,
            language: candidate.language,
            content,
            contentHash: candidate.contentHash,
            parsedFile: candidate.parsedFile,
          });
          if (candidate.parseStatus === "pending_intent") {
            candidate.parseStatus = candidate.parsedFile === null ? "metadata_only" : "parsed_intent";
          }
        }
        processedCandidates += 1;
        parsedSymbolCount += candidate.parsedFile?.nodes.length ?? 0;
        parsedReferenceCount += candidate.parsedFile?.unresolvedReferences.length ?? 0;
        telemetry.progress("tree_sitter_parsing", processedCandidates, changed.length);
      });
      const parsingMs = performance.now() - parsingStartedAt;
      telemetry.end("tree_sitter_parsing", {
        itemsProcessed: parsedItems,
        itemsSkipped: candidates.length - parsedItems,
        workMs: parserWorkMs,
      });
      telemetry.record("file_reading", fingerprintMs + (performance.now() - parsingStartedAt), {
        workMs: fingerprintReadWorkMs + parsingReadWorkMs,
        itemsProcessed: fingerprintCacheMisses + parsingReadCount,
        itemsSkipped: fingerprintCacheHits,
        cacheHits: fingerprintCacheHits,
        cacheMisses: fingerprintCacheMisses + parsingReadCount,
        inclusive: true,
      });
      telemetry.record("symbol_extraction", parserWorkMs, {
        itemsProcessed: parsedSymbolCount,
        inclusive: true,
      });
      telemetry.record("reference_extraction", parserWorkMs, {
        itemsProcessed: parsedReferenceCount,
        inclusive: true,
      });
      const previousFactPaths = [
        ...changed.map((candidate) =>
          changes.renamed.find((rename) => rename.path === candidate.relativePath)?.previousPath ??
            candidate.relativePath,
        ),
        ...changes.deleted,
      ];
      const previousFactsByPath = new Map(
        getFileSemanticFactsForPaths(database, previousFactPaths).map((facts) => [facts.path, facts]),
      );
      const compilerPublicApiByPath = new Map<string, CompilerPublicApiFacts>();
      const compilerCandidates: IndexedCandidate[] = [];
      for (const candidate of changed) {
        const shouldPersistFacts =
          candidate.parsedFile !== null ||
          isSourceLanguage(candidate.language) ||
          isModuleResolutionConfiguration(candidate.relativePath) ||
          candidate.parseStatus === "parsed_intent";
        if (!shouldPersistFacts) continue;
        if (candidate.content === null) {
          const readStartedAt = performance.now();
          candidate.content = await readFile(candidate.absolutePath, "utf8");
          parsingReadWorkMs += performance.now() - readStartedAt;
          parsingReadCount += 1;
        }
        const preliminaryFacts = buildFileSemanticFacts(
          candidate.relativePath,
          candidate.language,
          candidate.content,
          candidate.parsedFile,
          null,
        );
        candidate.semanticFacts = preliminaryFacts;

        const hasExports = candidate.parsedFile?.edges.some(
          (edge) => edge.edgeType === "EXPORTS",
        ) === true || candidate.parsedFile?.unresolvedReferences.some(
          (reference) => reference.kind === "export",
        ) === true;
        const compilerLanguage = ["typescript", "tsx", "javascript", "jsx"].includes(
          candidate.language ?? "",
        );
        if (!hasExports || !compilerLanguage) continue;

        const rename = changes.renamed.find((entry) => entry.path === candidate.relativePath);
        const previousFacts = rename === undefined
          ? previousFactsByPath.get(candidate.relativePath)
          : undefined;
        if (
          previousFacts !== undefined &&
          previousFacts.tokenFingerprint === preliminaryFacts.tokenFingerprint
        ) {
          const previousExports = new Map(
            previousFacts.exportedSymbols.map((entry) => [entry.id, entry]),
          );
          candidate.semanticFacts = {
            ...preliminaryFacts,
            publicApiFingerprint: previousFacts.publicApiFingerprint,
            exportedSymbols: preliminaryFacts.exportedSymbols.map((entry) =>
              previousExports.get(entry.id) ?? entry,
            ),
          };
          continue;
        }
        compilerCandidates.push(candidate);
      }

      if (compilerCandidates.length > 0) {
        const compilerApiResolver = new TypeScriptProjectResolver(
          repository.root,
          new Set(candidates.map((candidate) => candidate.relativePath)),
        );
        for (const candidate of compilerCandidates) {
          const facts = compilerApiResolver.publicApiFacts(candidate.relativePath);
          if (facts !== null) compilerPublicApiByPath.set(candidate.relativePath, facts);
          candidate.semanticFacts = buildFileSemanticFacts(
            candidate.relativePath,
            candidate.language,
            candidate.content!,
            candidate.parsedFile,
            facts,
          );
        }
      }

      const semanticDeltas: SemanticDelta[] = [];
      for (const candidate of changed) {
        const rename = changes.renamed.find((entry) => entry.path === candidate.relativePath);
        const previousPath = rename?.previousPath ?? candidate.relativePath;
        const previousFacts = previousFactsByPath.get(previousPath) ?? null;
        const forcedClass = moduleConfigurationChanged && isModuleResolutionConfiguration(candidate.relativePath)
          ? "module_resolution_change" as const
          : rename === undefined
            ? undefined
            : "renamed" as const;
        if (candidate.semanticFacts !== null || previousFacts !== null) {
          semanticDeltas.push(
            classifySemanticDelta(previousFacts, candidate.semanticFacts, forcedClass),
          );
        }
      }
      for (const deletedPath of changes.deleted) {
        const previousFacts = previousFactsByPath.get(deletedPath);
        if (previousFacts !== undefined) {
          semanticDeltas.push(
            classifySemanticDelta(
              previousFacts,
              null,
              isModuleResolutionConfiguration(deletedPath)
                ? "module_resolution_change"
                : undefined,
            ),
          );
        }
      }

      const invalidatedPaths = new Set<string>(unresolvedImporters);
      if (!fullRebuild) {
        const changedExportNodeIds = semanticDeltas.flatMap((delta) =>
          delta.publicContractChanged ? delta.changedExportNodeIds : [],
        );
        const changedExportNames = semanticDeltas.flatMap((delta) =>
          delta.publicContractChanged ? delta.changedExportNames : [],
        );
        for (const filePath of findConsumersOfSymbols(database, changedExportNodeIds)) {
          invalidatedPaths.add(filePath);
        }
        for (const filePath of findUnresolvedConsumersByName(database, changedExportNames)) {
          invalidatedPaths.add(filePath);
        }
        for (const filePath of findImportersOfFiles(
          database,
          changes.renamed.map((rename) => rename.previousPath),
        )) {
          invalidatedPaths.add(filePath);
        }
        if (moduleConfigurationChanged) {
          for (const filePath of listFileSemanticFactPaths(database)) {
            if (currentByPath.has(filePath)) invalidatedPaths.add(filePath);
          }
        }
      }
      for (const filePath of [...invalidatedPaths]) {
        if (!currentByPath.has(filePath) || directlyChangedPaths.has(filePath)) {
          invalidatedPaths.delete(filePath);
        }
      }
      for (const facts of getFileSemanticFactsForPaths(database, [...invalidatedPaths])) {
        previousFactsByPath.set(facts.path, facts);
      }
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
          if (rename.current.parsedFile !== null) {
            rename.current.parsedFile = plan.parsedFile;
            if (rename.current.content !== null) {
              rename.current.semanticFacts = buildFileSemanticFacts(
                rename.path,
                rename.current.language,
                rename.current.content,
                plan.parsedFile,
                compilerPublicApiByPath.get(rename.path) ?? null,
              );
            }
          }
        }
      }
      telemetry.record("file_reading", fingerprintMs + (performance.now() - parsingStartedAt), {
        workMs: fingerprintReadWorkMs + parsingReadWorkMs,
        itemsProcessed: fingerprintCacheMisses + parsingReadCount,
        itemsSkipped: fingerprintCacheHits,
        cacheHits: fingerprintCacheHits,
        cacheMisses: fingerprintCacheMisses + parsingReadCount,
        inclusive: true,
      });
      const indexedAt = new Date().toISOString();
      const changedPaths = new Set(changed.map((candidate) => candidate.relativePath));
      const structuralChanged =
        fullRebuild ||
        semanticDeltas.some((delta) => delta.graphChanged || delta.locationChanged) ||
        changes.added.length > 0 ||
        changes.deleted.length > 0 ||
        changes.renamed.length > 0;
      const semanticChanged =
        fullRebuild ||
        semanticDeltas.some((delta) => delta.semanticChanged) ||
        invalidatedPaths.size > 0;
      const searchChanged =
        fullRebuild ||
        semanticDeltas.some((delta) => delta.searchChanged) ||
        changes.added.length > 0 ||
        changes.deleted.length > 0 ||
        changes.renamed.length > 0;
      const architectureChanged =
        fullRebuild ||
        semanticDeltas.some((delta) => delta.architectureChanged) ||
        invalidatedPaths.size > 0 ||
        changes.added.length > 0 ||
        changes.deleted.length > 0 ||
        changes.renamed.length > 0;
      const previousGenerations = generationsFromState(storedState);
      const structuralGeneration = structuralChanged
        ? nextStructuralGeneration(storedState)
        : previousGenerations.structural;
      const semanticGeneration = semanticChanged
        ? previousGenerations.semantic + 1
        : previousGenerations.semantic;
      const searchGeneration = searchChanged
        ? previousGenerations.search + 1
        : previousGenerations.search;
      const analysisRequired =
        architectureChanged || storedState.architecture_status !== "current";
      const architectureGeneration = analysisRequired
        ? previousGenerations.architecture + 1
        : previousGenerations.architecture;
      telemetry.start("git_history_analysis");
      const historyCacheCurrent =
        !repository.gitAvailable || storedState.git_history_head === repository.headCommit;
      const history = repository.gitAvailable && analysisRequired && config.analysis.gitHistory
        ? historyCacheCurrent
          ? loadGitHistoryCache(database)
          : await collectRecentFileHistory(
              repository.root,
              new Set(candidates.map((candidate) => candidate.relativePath)),
            )
        : new Map();
      telemetry.end("git_history_analysis", {
        itemsProcessed: historyCacheCurrent ? 0 : history.size,
        itemsSkipped: !repository.gitAvailable || !analysisRequired || !config.analysis.gitHistory
          ? candidates.length
          : 0,
        cacheHits: historyCacheCurrent ? history.size : 0,
      });
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

      let analysisResult: ArchitectureAnalysisResult | null = null;
      const resolutionResult: { value: ResolutionResult | null } = { value: null };
      let ftsIndexingMs = 0;
      let ftsMutations = 0;
      const ftsMutationObserver = fullRebuild ? null : observeNodeSearchMutations(database);
      const deltaByPath = new Map(semanticDeltas.map((delta) => [delta.path, delta]));
      const directResolutionInputs = changed.flatMap((candidate) => {
        if (candidate.parsedFile === null) return [];
        const delta = deltaByPath.get(candidate.relativePath);
        const requiresResolution =
          fullRebuild ||
          delta?.outgoingChanged === true ||
          delta?.locationChanged === true ||
          delta?.changeClass === "added" ||
          delta?.changeClass === "renamed" ||
          delta?.changeClass === "module_resolution_change";
        return requiresResolution
          ? [{ relativePath: candidate.relativePath, parsedFile: candidate.parsedFile }]
          : [];
      });
      const dependentResolutionInputs = [...invalidatedPaths].flatMap((filePath) => {
        const facts = previousFactsByPath.get(filePath);
        if (facts === undefined) return [];
        return [{
          relativePath: filePath,
          parsedFile: {
            nodes: [],
            edges: [],
            unresolvedReferences: facts.references,
            errors: [],
          } satisfies ParsedFile,
        }];
      });
      const resolutionInputs = [...directResolutionInputs, ...dependentResolutionInputs];
      const resolvedPaths = [...new Set(resolutionInputs.map((input) => input.relativePath))];
      const frameworkMaterializationRequired = config.analysis.frameworks && (
        fullRebuild ||
        semanticDeltas.some((delta) =>
          delta.frameworkChanged ||
          delta.locationChanged ||
          delta.publicContractChanged ||
          delta.outgoingChanged ||
          delta.changeClass === "deleted" ||
          delta.changeClass === "renamed",
        )
      );
      let sqliteMutations = 0;
      const writeIndex = database.transaction(() => {
        if (fullRebuild) {
          suspendNodeSearchSync(database);
          database.exec(`
            DELETE FROM resolved_edges;
            DELETE FROM resolution_issues;
            DELETE FROM dependency_communities;
            DELETE FROM architecture_metrics;
            DELETE FROM edges;
            DELETE FROM nodes;
            DELETE FROM file_semantics;
            DELETE FROM files;
          `);
        } else {
          for (const filePath of changes.deleted) {
            deleteNodesForFile(database, filePath);
            deleteFileSemanticFacts(database, filePath);
            deleteFile(database, filePath);
          }
          for (const plan of renamePlans.values()) {
            deleteEdgesForFile(database, plan.previousPath);
            deleteResolutionIssuesForFile(database, plan.previousPath);
            deleteNodesById(database, plan.removedNodeIds);
            deleteFileSemanticFacts(database, plan.previousPath);
            deleteFile(database, plan.previousPath);
          }
          deleteNodesById(database, removedDirectoryNodeIds);
        }

        for (const candidate of changed) {
          if (!renamePlans.has(candidate.relativePath) && !fullRebuild) {
            deleteExtractedEdgesForFile(database, candidate.relativePath);
            deleteStaleNodesForFile(
              database,
              candidate.relativePath,
              new Set(candidate.parsedFile?.nodes.map((node) => node.id) ?? []),
            );
          }
          const record: FileRecord = {
            path: candidate.relativePath,
            language: candidate.language,
            contentHash: candidate.contentHash,
            sizeBytes: candidate.sizeBytes,
            mtimeMs: candidate.mtimeMs,
            ctimeMs: candidate.ctimeMs,
            parserVersion: candidate.adapterVersion === "none" ? "none" : TREE_SITTER_VERSION,
            adapterVersion: candidate.adapterVersion,
            indexedCommit: repository.headCommit,
            parseStatus: candidate.parseStatus,
            indexedAt,
          };
          upsertFile(database, record);
          if (candidate.semanticFacts !== null) {
            upsertFileSemanticFacts(database, candidate.semanticFacts, indexedAt);
          }
        }

        if (storedCommit !== repository.headCommit) {
          database.prepare("UPDATE files SET indexed_commit = ?").run(repository.headCommit);
        }

        deleteResolvedEdgesForFiles(database, resolvedPaths);
        for (const filePath of resolvedPaths) deleteResolutionIssuesForFile(database, filePath);

        const repositoryNodeId = createNodeId(repository.id, "repository", ".", repository.name);
        if (fullRebuild || storedCommit !== repository.headCommit) {
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
        }

        const packageByDirectory = new Map(
          workspacePackages.map((workspacePackage) => [workspacePackage.directory, workspacePackage]),
        );
        const packageNodeIds = new Map(
          workspacePackages.map((workspacePackage) => [
            workspacePackage.name,
            createNodeId(
              repository.id,
              "package",
              workspacePackage.manifestPath,
              workspacePackage.name,
            ),
          ]),
        );
        for (const workspacePackage of (fullRebuild || moduleConfigurationChanged ? workspacePackages : [])) {
          const id = packageNodeIds.get(workspacePackage.name)!;
          upsertNode(
            database,
            graphNode({
              id,
              kind: "package",
              name: workspacePackage.name,
              qualifiedName: workspacePackage.name,
              filePath: workspacePackage.manifestPath,
              sourceType: "config",
              provenance: "verified",
              metadata: {
                evidence: {
                  source_type: "config",
                  file: workspacePackage.manifestPath,
                  line: 1,
                  column: 0,
                },
                directory: workspacePackage.directory,
                version: workspacePackage.version,
                private: workspacePackage.isPrivate,
                has_exports: workspacePackage.hasExports,
              },
            }),
            indexedAt,
          );
          upsertEdge(
            database,
            graphEdge({
              id: createEdgeId(
                repository.id,
                "CONTAINS",
                repositoryNodeId,
                id,
                workspacePackage.manifestPath,
              ),
              sourceNodeId: repositoryNodeId,
              targetNodeId: id,
              edgeType: "CONTAINS",
              sourceType: "config",
              provenance: "verified",
              filePath: workspacePackage.manifestPath,
              line: 1,
            }),
            indexedAt,
          );
        }
        for (const workspacePackage of (fullRebuild || moduleConfigurationChanged ? workspacePackages : [])) {
          const sourceId = packageNodeIds.get(workspacePackage.name)!;
          for (const dependency of workspacePackage.dependencies) {
            const targetId = packageNodeIds.get(dependency);
            if (targetId === undefined) continue;
            upsertEdge(
              database,
              graphEdge({
                id: createEdgeId(
                  repository.id,
                  "DEPENDS_ON",
                  sourceId,
                  targetId,
                  workspacePackage.manifestPath,
                ),
                sourceNodeId: sourceId,
                targetNodeId: targetId,
                edgeType: "DEPENDS_ON",
                sourceType: "config",
                provenance: "verified",
                filePath: workspacePackage.manifestPath,
                line: 1,
              }),
              indexedAt,
            );
          }
        }

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
                  frameworkAdapterFailureCount:
                    candidate.parsedFile?.errors.filter((diagnostic) =>
                      diagnostic.message.startsWith("Framework adapter "),
                    ).length ?? 0,
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
          const owner = owningPackage(candidate.relativePath, packageByDirectory);
          const packageId = owner === null ? undefined : packageNodeIds.get(owner.name);
          if (packageId !== undefined && changedPaths.has(candidate.relativePath)) {
            upsertEdge(
              database,
              graphEdge({
                id: createEdgeId(
                  repository.id,
                  "CONTAINS",
                  packageId,
                  id,
                  candidate.relativePath,
                ),
                sourceNodeId: packageId,
                targetNodeId: id,
                edgeType: "CONTAINS",
                sourceType: "config",
                provenance: "verified",
                filePath: candidate.relativePath,
                line: 1,
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
          for (const edge of plan.renameEdges) {
            upsertEdge(database, edge, indexedAt, "rename_history");
          }
        }

        if (resolutionInputs.length > 0) {
          const resolutionReferenceCount = resolutionInputs.reduce(
            (count, input) => count + input.parsedFile.unresolvedReferences.length,
            0,
          );
          telemetry.start("graph_resolution", resolutionReferenceCount);
          resolutionResult.value = resolveReferences(
            database,
            repository.id,
            repository.root,
            resolutionInputs,
            indexedAt,
            (completed, total) => telemetry.progress("graph_resolution", completed, total),
          );
        }
        refreshArchitectureEdgeLocationsForFiles(
          database,
          repository.id,
          semanticDeltas
            .filter((delta) => delta.locationChanged && !delta.architectureChanged)
            .map((delta) => delta.path),
          indexedAt,
        );
        if (frameworkMaterializationRequired) {
          materializeFrameworkRelationships(
            database,
            repository.id,
            repository.root,
            indexedAt,
          );
        }

        if (fullRebuild) {
          const ftsStartedAt = performance.now();
          rebuildNodeSearch(database);
          ftsIndexingMs = performance.now() - ftsStartedAt;
        }
        if (
          repository.gitAvailable &&
          analysisRequired &&
          config.analysis.gitHistory &&
          !historyCacheCurrent
        ) {
          replaceGitHistoryCache(database, history);
        }

        const repositoryStates: Record<string, string> = {
          schema_version: String(SCHEMA_VERSION),
          codeatlas_version: CODEATLAS_VERSION,
          indexer_version: INDEXER_VERSION,
          last_indexed_commit: repository.headCommit,
          last_indexed_at: indexedAt,
          repository_root: repository.root,
          repository_id: repository.id,
          git_available: String(repository.gitAvailable),
          dirty_fingerprint: fingerprint.fingerprint,
          worktree_signature: worktree.signature,
          worktree_changed_paths: JSON.stringify(worktree.changedPaths),
          config_hash: configHash,
          working_tree_dirty: String(worktree.dirty),
          structural_generation: String(structuralGeneration),
          semantic_generation: String(semanticGeneration),
          search_generation: String(searchGeneration),
          content_generation: String(
            Number.parseInt(storedState.content_generation ?? "0", 10) +
              (changed.length > 0 || changes.deleted.length > 0 ? 1 : 0),
          ),
          structural_status: "current",
          semantic_status: "current",
          search_status: "current",
          architecture_status: analysisRequired ? "pending" : "current",
          ...(repository.gitAvailable && config.analysis.gitHistory
            ? { git_history_head: repository.headCommit }
            : {}),
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
            semanticDeltas: semanticDeltas.map((delta) => ({
              path: delta.path,
              class: delta.changeClass,
              publicContractChanged: delta.publicContractChanged,
              outgoingChanged: delta.outgoingChanged,
            })),
            invalidationTruncated,
            invalidationTruncationReason,
            fullRebuild,
          }),
        };
        setRepositoryStates(database, repositoryStates);
      });
      const persistenceStartedAt = performance.now();
      telemetry.start("database_writes");
      const changesBefore = database.prepare("SELECT total_changes() AS value").get() as { value: number };
      writeIndex();
      const changesAfter = database.prepare("SELECT total_changes() AS value").get() as { value: number };
      sqliteMutations = changesAfter.value - changesBefore.value;
      const persistenceMs = performance.now() - persistenceStartedAt;
      const resolution = resolutionResult.value;
      const resolutionInclusiveMs = resolution?.graphResolutionMs ?? 0;
      telemetry.record("database_writes", persistenceMs, {
        workMs: Math.max(0, persistenceMs - resolutionInclusiveMs - ftsIndexingMs),
        itemsProcessed: sqliteMutations,
        inclusive: true,
      });
      if (resolution !== null) {
        telemetry.record("typescript_project_discovery", resolution.typescript.projectDiscoveryMs, {
          itemsProcessed: resolution.typescript.projectsDiscovered,
          cacheHits: resolution.typescript.projectCacheHits,
        });
        telemetry.record("typescript_program_creation", resolution.typescript.programCreationMs, {
          itemsProcessed: resolution.typescript.programsCreated,
        });
        telemetry.record(
          "typescript_semantic_resolution",
          resolution.typescript.semanticResolutionMs,
          {
            itemsProcessed: resolution.typescript.semanticSourcesIndexed,
            cacheHits: resolution.typescript.semanticCacheHits,
            cacheMisses: resolution.typescript.semanticCacheMisses,
          },
        );
        telemetry.record("module_import_resolution", resolution.typescript.moduleResolutionMs, {
          itemsProcessed: resolution.typescript.moduleCacheMisses,
          cacheHits: resolution.typescript.moduleCacheHits,
          cacheMisses: resolution.typescript.moduleCacheMisses,
        });
        telemetry.record("candidate_generation", resolution.candidateGenerationMs, {
          itemsProcessed: resolution.candidates,
        });
        telemetry.record("graph_resolution", resolution.graphResolutionMs, {
          workMs: Math.max(
            0,
            resolution.graphResolutionMs -
              resolution.candidateGenerationMs -
              resolution.typescript.projectDiscoveryMs -
              resolution.typescript.programCreationMs -
              resolution.typescript.semanticResolutionMs -
              resolution.typescript.moduleResolutionMs,
          ),
          itemsProcessed: resolution.edges,
          inclusive: true,
        });
      }
      options.afterStructuralCommit?.();

      const architectureStartedAt = performance.now();
      telemetry.start("architecture_domain_feature_analysis");
      if (analysisRequired) {
        analysisResult = runArchitectureAnalysis(
          database,
          repository.id,
          config,
          history,
          indexedAt,
          architectureGeneration,
        );
      }
      const architectureMs = performance.now() - architectureStartedAt;
      if (analysisResult === null) {
        telemetry.end("architecture_domain_feature_analysis", {
          itemsSkipped: candidates.length,
        });
      } else {
        telemetry.record(
          "architecture_domain_feature_analysis",
          analysisResult.timingsMs.graphLoading + analysisResult.timingsMs.domainFeatureAnalysis,
          { itemsProcessed: candidates.length },
        );
        telemetry.record("community_detection", analysisResult.timingsMs.communityDetection, {
          itemsProcessed: analysisResult.communities,
        });
        telemetry.record("cycle_detection", analysisResult.timingsMs.cycleDetection, {
          itemsProcessed: analysisResult.cycles,
        });
        telemetry.record("hotspot_analysis", analysisResult.timingsMs.hotspotAnalysis, {
          itemsProcessed: analysisResult.hotspots,
        });
      }

      ftsMutations = ftsMutationObserver?.finish() ?? 0;

      telemetry.start("finalization");
      const counts = database
        .prepare(
          `SELECT
            (SELECT count(*) FROM nodes) AS nodes,
            (SELECT count(*) FROM edges) AS edges,
            (SELECT count(*) FROM nodes
              WHERE kind NOT IN (
                'repository', 'package', 'directory', 'file', 'module', 'feature', 'domain',
                'documentation'
              )) AS symbols,
            (SELECT count(*) FROM nodes WHERE kind = 'api_route') AS apiRoutes,
            (SELECT count(*) FROM nodes WHERE kind = 'database_model') AS databaseModels,
            (SELECT count(*) FROM nodes WHERE kind = 'feature') AS features,
            (SELECT count(*) FROM nodes WHERE kind = 'domain') AS domains,
            (SELECT count(DISTINCT community_id) FROM dependency_communities) AS communities,
            (SELECT count(*) FROM architecture_findings
              WHERE finding_type = 'circular_dependency') AS cycles,
            (SELECT count(*) FROM architecture_findings
              WHERE finding_type = 'change_hotspot') AS hotspots,
            (SELECT count(*) FROM architecture_findings) AS findings,
            (SELECT count(*) FROM files
              WHERE parse_status IN ('parsed_with_errors', 'parse_error')) AS parseErrors`,
        )
        .get() as {
          nodes: number;
          edges: number;
          symbols: number;
          apiRoutes: number;
          databaseModels: number;
          features: number;
          domains: number;
          communities: number;
          cycles: number;
          hotspots: number;
          findings: number;
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
      if (fullRebuild) ftsMutations = counts.nodes;
      telemetry.record("fts_search_indexing", fullRebuild ? ftsIndexingMs : 0, {
        workMs: fullRebuild ? ftsIndexingMs : null,
        itemsProcessed: ftsMutations,
        inclusive: !fullRebuild,
      });

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
      telemetry.end("finalization", { itemsProcessed: candidates.length });
      const phaseMetrics = telemetry.finish();
      const peakRssBytes = Math.max(...phaseMetrics.map((metric) => metric.peakRssBytes));
      const semanticChangeClasses: SemanticChangeClass[] = [
        "content_only",
        "implementation_only",
        "outgoing_change",
        "public_contract_change",
        "module_resolution_change",
        "added",
        "deleted",
        "renamed",
      ];
      const semanticChanges = Object.fromEntries(
        semanticChangeClasses.map((changeClass) => [
          changeClass,
          semanticDeltas.filter((delta) => delta.changeClass === changeClass).length,
        ]),
      ) as Record<SemanticChangeClass, number>;
      const work = {
        filesRead: fingerprintCacheMisses + parsingReadCount,
        filesParsed: parsedItems,
        filesSemanticallyAnalyzed: resolution?.typescript.semanticSourcesIndexed ?? 0,
        dependentFilesInvalidated: invalidatedPaths.size,
        symbolsRewritten: changed.flatMap((candidate) => candidate.parsedFile?.nodes ?? []).length,
        referencesRewritten: resolutionInputs.reduce(
          (total, input) => total + input.parsedFile.unresolvedReferences.length,
          0,
        ),
        candidateCount: resolution?.candidates ?? 0,
        resolvedEdgeCount: resolution?.edges ?? 0,
        sqliteMutations,
        ftsMutations,
        architectureFiles: analysisRequired ? candidates.length : 0,
      };
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
        features: counts.features,
        domains: counts.domains,
        communities: counts.communities,
        cycles: counts.cycles,
        hotspots: counts.hotspots,
        findings: counts.findings,
        generations: {
          structural: structuralGeneration,
          semantic: semanticGeneration,
          search: searchGeneration,
          architecture: architectureGeneration,
        },
        semanticChanges,
        work,
        phaseMetrics,
        peakRssBytes,
        changes: {
          updated: changed.length,
          added: changes.added.length,
          modified: changes.modified.length,
          deleted: changes.deleted.length,
          renamed: changes.renamed.length,
          invalidated: invalidatedPaths.size,
          invalidationTruncated,
          invalidationTruncationReason,
          fullRebuild,
          dirtyWorkingTree: gitState.dirty,
        },
        timingsMs: {
          discovery: discoveryMs,
          fingerprint: fingerprintMs,
          parsing: parsingMs,
          persistence: persistenceMs,
          architecture: architectureMs,
          total: performance.now() - indexStartedAt,
        },
      });

      const timingsMs = {
        discovery: Number(discoveryMs.toFixed(2)),
        fingerprint: Number(fingerprintMs.toFixed(2)),
        parsing: Number(parsingMs.toFixed(2)),
        persistence: Number(persistenceMs.toFixed(2)),
        architecture: Number(architectureMs.toFixed(2)),
        total: Number((performance.now() - indexStartedAt).toFixed(2)),
      };
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
        invalidationTruncated,
        invalidationTruncationReason,
        fullRebuild,
        dirtyWorkingTree: gitState.dirty,
        nodes: counts.nodes,
        edges: counts.edges,
        symbols: counts.symbols,
        parseErrors: counts.parseErrors,
        apiRoutes: counts.apiRoutes,
        databaseModels: counts.databaseModels,
        features: counts.features,
        domains: counts.domains,
        communities: counts.communities,
        cycles: counts.cycles,
        hotspots: counts.hotspots,
        findings: counts.findings,
        languages,
        frameworks,
        indexedAt,
        generations: {
          structural: structuralGeneration,
          semantic: semanticGeneration,
          search: searchGeneration,
          architecture: architectureGeneration,
        },
        semanticChanges,
        work,
        phaseMetrics,
        peakRssBytes,
        timingsMs,
      };
    } finally {
      database.close();
    }
  } finally {
    telemetry.finish();
    await releaseLock();
  }
}
