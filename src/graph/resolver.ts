import path from "node:path";
import { sha256 } from "../core/hashing.js";
import type { ParsedFile, UnresolvedReference } from "../parser/parser.js";
import type { AtlasDatabase } from "../storage/database.js";
import { upsertEdge } from "../storage/edges.js";
import { upsertResolutionIssue } from "../storage/resolution-issues.js";
import { createEdgeId } from "./ids.js";
import type { EdgeType, GraphEdge, NodeKind, SourceType } from "./types.js";
import { TypeScriptProjectResolver } from "./typescript-resolution.js";

interface StoredNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string | null;
  filePath: string | null;
}

interface NodeRow {
  id: string;
  kind: NodeKind;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
}

interface ParsedInput {
  relativePath: string;
  parsedFile: ParsedFile;
}

interface ImportBinding {
  localName: string;
  importedName: string;
  targetFilePath: string;
}

interface CandidateSet {
  nodes: StoredNode[];
  exact: boolean;
  sourceType?: SourceType;
}

interface SymbolIndexes {
  byName: ReadonlyMap<string, readonly StoredNode[]>;
  byFile: ReadonlyMap<string, readonly StoredNode[]>;
  byFileAndName: ReadonlyMap<string, readonly StoredNode[]>;
  byFileAndQualifiedName: ReadonlyMap<string, readonly StoredNode[]>;
}

type PythonModuleIndex = ReadonlyMap<string, readonly string[]>;

const MAX_DYNAMIC_CANDIDATES = 20;
const DYNAMIC_REFERENCE_KINDS = new Set<UnresolvedReference["kind"]>([
  "callback",
  "event_subscribe",
  "event_publish",
  "queue_subscribe",
  "queue_publish",
  "dependency_injection",
  "runtime_registration",
  "reflection",
]);

export interface ResolutionResult {
  edges: number;
  unresolved: number;
  ambiguous: number;
}

const SYMBOL_KINDS = new Set<NodeKind>([
  "class",
  "interface",
  "function",
  "method",
  "variable",
]);

const JAVASCRIPT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

function loadNodes(database: AtlasDatabase): StoredNode[] {
  const rows = database
    .prepare("SELECT id, kind, name, qualified_name, file_path FROM nodes ORDER BY id")
    .all() as NodeRow[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
  }));
}

function uniqueNodes(nodes: readonly StoredNode[]): StoredNode[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function addToIndex(
  index: Map<string, StoredNode[]>,
  key: string,
  node: StoredNode,
): void {
  const values = index.get(key) ?? [];
  values.push(node);
  index.set(key, values);
}

function buildSymbolIndexes(nodes: readonly StoredNode[]): SymbolIndexes {
  const byName = new Map<string, StoredNode[]>();
  const byFile = new Map<string, StoredNode[]>();
  const byFileAndName = new Map<string, StoredNode[]>();
  const byFileAndQualifiedName = new Map<string, StoredNode[]>();
  for (const node of nodes) {
    addToIndex(byName, node.name, node);
    if (node.filePath === null) continue;
    addToIndex(byFile, node.filePath, node);
    addToIndex(byFileAndName, `${node.filePath}\0${node.name}`, node);
    if (node.qualifiedName !== null) {
      addToIndex(byFileAndQualifiedName, `${node.filePath}\0${node.qualifiedName}`, node);
    }
  }
  return { byName, byFile, byFileAndName, byFileAndQualifiedName };
}

function buildPythonModuleIndex(modulePaths: Iterable<string>): PythonModuleIndex {
  const paths = [...modulePaths].filter((filePath) => /\.pyi?$/u.test(filePath));
  const packageDirectories = new Set(
    paths
      .filter((filePath) => /(?:^|\/)__init__\.pyi?$/u.test(filePath))
      .map((filePath) => path.posix.dirname(filePath)),
  );
  const index = new Map<string, string[]>();
  for (const filePath of paths) {
    const extension = path.posix.extname(filePath);
    const withoutExtension = filePath.slice(0, -extension.length);
    const modulePath = withoutExtension.endsWith("/__init__")
      ? path.posix.dirname(withoutExtension)
      : withoutExtension;
    let packageRoot = path.posix.dirname(modulePath);
    while (packageDirectories.has(packageRoot) && packageDirectories.has(path.posix.dirname(packageRoot))) {
      packageRoot = path.posix.dirname(packageRoot);
    }
    const relativeToPackage = packageDirectories.has(path.posix.dirname(modulePath)) ||
        packageDirectories.has(modulePath)
      ? path.posix.relative(path.posix.dirname(packageRoot), modulePath)
      : modulePath.startsWith("src/")
        ? modulePath.slice(4)
        : modulePath;
    const specifier = relativeToPackage.replaceAll("/", ".");
    const candidates = index.get(specifier) ?? [];
    candidates.push(filePath);
    index.set(specifier, candidates);
  }
  return index;
}

function moduleCandidates(
  reference: UnresolvedReference,
  modulesByFile: ReadonlyMap<string, StoredNode>,
  projectResolver: TypeScriptProjectResolver,
  pythonModules: PythonModuleIndex,
): StoredNode[] {
  const sourceDirectory = path.posix.dirname(reference.evidence.file);
  const candidatePaths = new Set<string>();

  for (const candidate of projectResolver.resolveModule(reference.name, reference.evidence.file)) {
    candidatePaths.add(candidate);
  }

  if (reference.name.startsWith(".")) {
    if (reference.evidence.file.endsWith(".py") || reference.evidence.file.endsWith(".pyi")) {
      const prefix = reference.name.match(/^\.+/u)?.[0] ?? ".";
      let baseDirectory = sourceDirectory;
      for (let level = 1; level < prefix.length; level += 1) {
        baseDirectory = path.posix.dirname(baseDirectory);
      }
      const modulePart = reference.name.slice(prefix.length).replaceAll(".", "/");
      const base = path.posix.normalize(path.posix.join(baseDirectory, modulePart));
      candidatePaths.add(`${base}.py`);
      candidatePaths.add(`${base}.pyi`);
      candidatePaths.add(path.posix.join(base, "__init__.py"));
    } else {
      const base = path.posix.normalize(path.posix.join(sourceDirectory, reference.name));
      candidatePaths.add(base);
      const sourceExtension = path.posix.extname(base);
      const hasKnownRuntimeExtension =
        JAVASCRIPT_EXTENSIONS.some((extension) => extension === sourceExtension) ||
        sourceExtension === ".json";
      if (!hasKnownRuntimeExtension) {
        for (const extension of JAVASCRIPT_EXTENSIONS) {
          candidatePaths.add(`${base}${extension}`);
          candidatePaths.add(path.posix.join(base, `index${extension}`));
        }
        candidatePaths.add(`${base}.json`);
      } else {
        const withoutExtension = base.slice(0, -sourceExtension.length);
        if (sourceExtension === ".js" || sourceExtension === ".jsx") {
          candidatePaths.add(`${withoutExtension}.ts`);
          candidatePaths.add(`${withoutExtension}.tsx`);
        } else if (sourceExtension === ".mjs") {
          candidatePaths.add(`${withoutExtension}.mts`);
        } else if (sourceExtension === ".cjs") {
          candidatePaths.add(`${withoutExtension}.cts`);
        }
      }
    }
  } else if (reference.evidence.file.endsWith(".py") || reference.evidence.file.endsWith(".pyi")) {
    for (const filePath of pythonModules.get(reference.name) ?? []) candidatePaths.add(filePath);
  }

  return uniqueNodes(
    [...candidatePaths]
      .map((candidatePath) => modulesByFile.get(candidatePath))
      .filter((node): node is StoredNode => node !== undefined),
  );
}

function edgeTypeFor(reference: UnresolvedReference): EdgeType {
  switch (reference.kind) {
    case "import":
      return "IMPORTS";
    case "export":
      return "EXPORTS";
    case "call":
    case "callback":
      return "CALLS";
    case "event_subscribe":
    case "queue_subscribe":
      return "SUBSCRIBES";
    case "event_publish":
    case "queue_publish":
      return "PUBLISHES";
    case "dependency_injection":
      return "DEPENDS_ON";
    case "runtime_registration":
      return "CONFIGURES";
    case "extends":
      return "EXTENDS";
    case "implements":
      return "IMPLEMENTS";
    case "reference":
    case "reflection":
    case "generated":
      return "REFERENCES";
  }
}

function expectedKinds(reference: UnresolvedReference): ReadonlySet<NodeKind> {
  if (
    reference.kind === "call" ||
    reference.kind === "callback" ||
    reference.kind === "event_subscribe" ||
    reference.kind === "queue_subscribe"
  ) {
    return new Set(["function", "method", "class"]);
  }
  if (reference.kind === "dependency_injection") {
    return new Set(["class", "interface", "function"]);
  }
  if (reference.kind === "extends") return new Set(["class", "interface"]);
  if (reference.kind === "implements") return new Set(["interface"]);
  return SYMBOL_KINDS;
}

function ownerQualifiedName(source: StoredNode): string | null {
  if (source.qualifiedName === null) return null;
  const pieces = source.qualifiedName.split(".");
  return pieces.length > 1 ? pieces.slice(0, -1).join(".") : null;
}

function lexicalScore(source: StoredNode, candidate: StoredNode): number {
  if (source.filePath !== candidate.filePath) return -1;
  const sourceParts = (source.qualifiedName ?? "").split(".");
  const candidateParent = (candidate.qualifiedName ?? "").split(".").slice(0, -1);
  let common = 0;
  while (common < sourceParts.length && sourceParts[common] === candidateParent[common]) {
    common += 1;
  }
  return common;
}

function byNameInFile(
  indexes: SymbolIndexes,
  filePath: string,
  name: string,
  kinds: ReadonlySet<NodeKind>,
): StoredNode[] {
  return (indexes.byFileAndName.get(`${filePath}\0${name}`) ?? [])
    .filter((node) => kinds.has(node.kind));
}

function importedCandidates(
  reference: UnresolvedReference,
  binding: ImportBinding,
  indexes: SymbolIndexes,
  exportedNodeIds: ReadonlySet<string>,
  kinds: ReadonlySet<NodeKind>,
): StoredNode[] {
  const parts = reference.name.split(".");
  const remainder = parts.slice(1);
  if (binding.importedName === "*") {
    const targetName = remainder[0];
    if (targetName === undefined) return [];
    const roots = byNameInFile(indexes, binding.targetFilePath, targetName, kinds);
    if (remainder.length === 1) return roots;
    const suffix = remainder.slice(1).join(".");
    return (indexes.byFile.get(binding.targetFilePath) ?? []).filter((node) =>
      roots.some(
        (root) =>
          node.filePath === binding.targetFilePath &&
          kinds.has(node.kind) &&
          node.qualifiedName === `${root.qualifiedName}.${suffix}`,
      ),
    );
  }

  if (binding.importedName === "default") {
    const roots = (indexes.byFile.get(binding.targetFilePath) ?? []).filter(
      (node) =>
        node.filePath === binding.targetFilePath &&
        kinds.has(node.kind) &&
        (node.name === "default" || exportedNodeIds.has(node.id)),
    );
    if (remainder.length === 0) return roots;
    const suffix = remainder.join(".");
    return (indexes.byFile.get(binding.targetFilePath) ?? []).filter((node) =>
      roots.some(
        (root) =>
          node.filePath === binding.targetFilePath &&
          kinds.has(node.kind) &&
          node.qualifiedName === `${root.qualifiedName}.${suffix}`,
      ),
    );
  }

  const roots = byNameInFile(indexes, binding.targetFilePath, binding.importedName, kinds);
  if (remainder.length === 0) return roots;
  const suffix = remainder.join(".");
  return (indexes.byFile.get(binding.targetFilePath) ?? []).filter((node) =>
    roots.some(
      (root) =>
        node.filePath === binding.targetFilePath &&
        kinds.has(node.kind) &&
        node.qualifiedName === `${root.qualifiedName}.${suffix}`,
    ),
  );
}

function symbolCandidates(
  reference: UnresolvedReference,
  source: StoredNode,
  indexes: SymbolIndexes,
  bindings: readonly ImportBinding[],
  exportedNodeIds: ReadonlySet<string>,
  modulesByFile: ReadonlyMap<string, StoredNode>,
  distances: ImportDistanceIndex,
  projectResolver: TypeScriptProjectResolver,
): CandidateSet {
  const kinds = expectedKinds(reference);
  const parts = reference.name.split(".");
  const first = parts[0] ?? reference.name;
  const last = parts.at(-1) ?? reference.name;

  if (reference.kind === "export") {
    return {
      nodes: byNameInFile(indexes, reference.evidence.file, reference.name, kinds),
      exact: true,
    };
  }

  if (first === "this" || first === "self") {
    const owner = ownerQualifiedName(source);
    if (owner !== null) {
      const qualifiedName = `${owner}.${parts.slice(1).join(".")}`;
      const scoped = (indexes.byFileAndQualifiedName.get(
        `${source.filePath ?? reference.evidence.file}\0${qualifiedName}`,
      ) ?? []).filter((node) => kinds.has(node.kind));
      if (scoped.length > 0) return { nodes: scoped, exact: true };
    }
  }
  if (first === "super") return { nodes: [], exact: false };

  const matchingBindings = bindings.filter((binding) => binding.localName === first);
  if (matchingBindings.length > 0) {
    return {
      nodes: uniqueNodes(
        matchingBindings.flatMap((binding) =>
          importedCandidates(reference, binding, indexes, exportedNodeIds, kinds),
        ),
      ),
      exact: true,
    };
  }

  if (parts.length > 1) {
    const roots = byNameInFile(indexes, reference.evidence.file, first, SYMBOL_KINDS);
    const qualified = (indexes.byFile.get(reference.evidence.file) ?? []).filter((node) =>
      roots.some(
        (root) =>
          node.filePath === reference.evidence.file &&
          node.qualifiedName === `${root.qualifiedName}.${parts.slice(1).join(".")}` &&
          kinds.has(node.kind),
      ),
    );
    if (qualified.length > 0) return { nodes: qualified, exact: true };
    if (
      reference.kind === "call" ||
      reference.kind === "callback" ||
      DYNAMIC_REFERENCE_KINDS.has(reference.kind)
    ) {
      const semantic = projectResolver.resolveCall(reference);
      if (semantic !== null) {
        const compiler = byNameInFile(indexes, semantic.filePath, semantic.name, kinds);
        if (compiler.length > 0) return { nodes: compiler, exact: true, sourceType: "compiler" };
      }
      const polymorphicCandidates = (indexes.byName.get(last) ?? [])
        .filter((node) => {
          if (node.name !== last || !kinds.has(node.kind) || node.filePath === null) {
            return false;
          }
          return modulesByFile.get(node.filePath) !== undefined;
        })
        .slice(0, MAX_DYNAMIC_CANDIDATES);
      const polymorphic = distances.reachableCandidates(
        reference.evidence.file,
        polymorphicCandidates,
        modulesByFile,
      );
      if (polymorphic.length > 0) return { nodes: polymorphic, exact: false };
    }
    return { nodes: [], exact: false };
  }

  const local = byNameInFile(indexes, reference.evidence.file, last, kinds);
  if (local.length > 0) {
    const scored = local.map((node) => ({ node, score: lexicalScore(source, node) }));
    const best = Math.max(...scored.map((candidate) => candidate.score));
    return {
      nodes: scored.filter((candidate) => candidate.score === best).map((candidate) => candidate.node),
      exact: true,
    };
  }

  const named = (indexes.byName.get(last) ?? []).filter(
    (node) => kinds.has(node.kind) && node.filePath !== null,
  );
  return {
    nodes: distances.reachableCandidates(reference.evidence.file, named, modulesByFile),
    exact: false,
  };
}

class ImportDistanceIndex {
  readonly #adjacency: ReadonlyMap<string, ReadonlySet<string>>;
  readonly #cache = new Map<string, ReadonlyMap<string, number>>();

  constructor(
    database: AtlasDatabase,
    modulesByFile: ReadonlyMap<string, StoredNode>,
    nodeById: ReadonlyMap<string, StoredNode>,
  ) {
    const adjacency = new Map<string, Set<string>>();
    const rows = database
      .prepare("SELECT source_node_id, target_node_id FROM edges WHERE edge_type = 'IMPORTS'")
      .all() as Array<{ source_node_id: string; target_node_id: string }>;
    for (const row of rows) {
      const source = nodeById.get(row.source_node_id);
      const target = nodeById.get(row.target_node_id);
      if (source?.filePath === null || source?.filePath === undefined) continue;
      if (target?.filePath === null || target?.filePath === undefined) continue;
      const sourceModule = modulesByFile.get(source.filePath);
      const targetModule = modulesByFile.get(target.filePath);
      if (sourceModule === undefined || targetModule === undefined) continue;
      const neighbors = adjacency.get(sourceModule.id) ?? new Set<string>();
      neighbors.add(targetModule.id);
      adjacency.set(sourceModule.id, neighbors);
    }
    this.#adjacency = adjacency;
  }

  #from(startId: string): ReadonlyMap<string, number> {
    const cached = this.#cache.get(startId);
    if (cached !== undefined) return cached;
    const distances = new Map<string, number>([[startId, 0]]);
    const queue = [startId];
    for (let head = 0; head < queue.length && distances.size < 5_000; head += 1) {
      const current = queue[head]!;
      const distance = distances.get(current)!;
      if (distance >= 12) continue;
      for (const neighbor of this.#adjacency.get(current) ?? []) {
        if (distances.has(neighbor)) continue;
        distances.set(neighbor, distance + 1);
        queue.push(neighbor);
        if (distances.size >= 5_000) break;
      }
    }
    // Resolution inputs are file-grouped. A small LRU bounds memory even on full rebuilds.
    this.#cache.set(startId, distances);
    if (this.#cache.size > 128) this.#cache.delete(this.#cache.keys().next().value!);
    return distances;
  }

  distance(
    sourceFile: string,
    targetFile: string,
    modulesByFile: ReadonlyMap<string, StoredNode>,
  ): number {
    const source = modulesByFile.get(sourceFile);
    const target = modulesByFile.get(targetFile);
    if (source === undefined || target === undefined) return 20;
    return this.#from(source.id).get(target.id) ?? 20;
  }

  reachableCandidates(
    sourceFile: string,
    candidates: readonly StoredNode[],
    modulesByFile: ReadonlyMap<string, StoredNode>,
  ): StoredNode[] {
    const source = modulesByFile.get(sourceFile);
    if (source === undefined) return [];
    const reachable = this.#from(source.id);
    return candidates.filter((candidate) => {
      if (candidate.filePath === null) return false;
      const target = modulesByFile.get(candidate.filePath);
      return target !== undefined && reachable.has(target.id);
    });
  }
}

function candidateDistance(
  reference: UnresolvedReference,
  candidate: StoredNode,
  modulesByFile: ReadonlyMap<string, StoredNode>,
  distances: ImportDistanceIndex,
): number {
  if (candidate.filePath === null) return 20;
  return distances.distance(reference.evidence.file, candidate.filePath, modulesByFile);
}

function confidenceFor(distance: number, candidateCount: number, exact: boolean): number {
  if (candidateCount === 1 && exact) return 1;
  const base = exact ? 0.9 : 0.75;
  return Math.max(0.2, Number((base - Math.min(distance, 10) * 0.04 - (candidateCount - 1) * 0.05).toFixed(2)));
}

function persistIssue(
  database: AtlasDatabase,
  reference: UnresolvedReference,
  reason:
    | "unresolved_reference"
    | "multi_candidate"
    | "dynamic_relationship"
    | "generated_code",
  candidates: readonly StoredNode[],
  timestamp: string,
): void {
  const referenceHash = sha256(`${reference.kind}:${reference.name}`);
  const safeName =
    reference.kind !== "import" &&
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(reference.name)
      ? reference.name
      : null;
  upsertResolutionIssue(
    database,
    {
      id: sha256(
        `${reference.sourceNodeId}:${referenceHash}:${reference.evidence.file}:${reference.evidence.line}:${reference.evidence.column}`,
      ),
      sourceNodeId: reference.sourceNodeId,
      referenceKind: reference.kind,
      referenceName: safeName,
      referenceHash,
      filePath: reference.evidence.file,
      line: reference.evidence.line,
      column: reference.evidence.column,
      reason,
      candidateNodeIds: candidates.map((candidate) => candidate.id),
      metadata: {
        evidence: {
          source_type: reference.evidence.sourceType,
          file: reference.evidence.file,
          line: reference.evidence.line,
          column: reference.evidence.column,
        },
        provenance: reason === "unresolved_reference" ? "unresolved" : reference.provenance,
        relationship_kind: reference.kind,
        confidence: reference.confidence,
        ...reference.metadata,
      },
    },
    timestamp,
  );
}

function persistEdges(
  database: AtlasDatabase,
  repositoryId: string,
  reference: UnresolvedReference,
  candidates: readonly StoredNode[],
  exact: boolean,
  modulesByFile: ReadonlyMap<string, StoredNode>,
  distances: ImportDistanceIndex | null,
  timestamp: string,
  edgeIds: Set<string>,
  sourceTypeOverride?: SourceType,
): void {
  for (const candidate of candidates) {
    const distance = distances === null
      ? 1
      : candidateDistance(reference, candidate, modulesByFile, distances);
    const sourceType: SourceType = sourceTypeOverride ??
      (exact && candidates.length === 1 ? "ast" : "heuristic");
    const edgeType = edgeTypeFor(reference);
    const id = createEdgeId(
      repositoryId,
      edgeType,
      reference.sourceNodeId,
      candidate.id,
      reference.evidence.file,
      reference.evidence.line,
    );
    const edge: GraphEdge = {
      id,
      sourceNodeId: reference.sourceNodeId,
      targetNodeId: candidate.id,
      edgeType,
      sourceType,
      provenance:
        reference.provenance === "dynamic" || reference.provenance === "documentation"
          ? reference.provenance
          : sourceType === "heuristic"
            ? "inferred"
            : "verified",
      confidence: Math.min(
        reference.confidence,
        confidenceFor(distance, candidates.length, exact),
      ),
      filePath: reference.evidence.file,
      line: reference.evidence.line,
      metadata: {
        evidence: {
          source_type: reference.evidence.sourceType,
          file: reference.evidence.file,
          line: reference.evidence.line,
          column: reference.evidence.column,
        },
        resolution: candidates.length > 1 ? "ambiguous" : exact ? "exact" : "unique_candidate",
        candidate_count: candidates.length,
        import_graph_distance: distance === 20 ? null : distance,
        relationship_kind: reference.kind,
        ...reference.metadata,
      },
    };
    upsertEdge(database, edge, timestamp);
    edgeIds.add(id);
  }
}

export function resolveReferences(
  database: AtlasDatabase,
  repositoryId: string,
  repositoryRoot: string,
  parsedInputs: readonly ParsedInput[],
  timestamp: string,
): ResolutionResult {
  const nodes = loadNodes(database);
  const indexes = buildSymbolIndexes(nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const modulesByFile = new Map<string, StoredNode>();
  for (const node of nodes) {
    if (node.kind === "file" && node.filePath !== null) modulesByFile.set(node.filePath, node);
  }
  const projectResolver = new TypeScriptProjectResolver(
    repositoryRoot,
    new Set(modulesByFile.keys()),
  );
  for (const node of nodes) {
    if (node.kind === "module" && node.filePath !== null) modulesByFile.set(node.filePath, node);
  }
  const pythonModules = buildPythonModuleIndex(modulesByFile.keys());
  const exportedNodeIds = new Set(
    (
      database.prepare("SELECT target_node_id FROM edges WHERE edge_type = 'EXPORTS'").all() as Array<{
        target_node_id: string;
      }>
    ).map((row) => row.target_node_id),
  );
  const bindingsByFile = new Map<string, ImportBinding[]>();
  const importReferences: UnresolvedReference[] = [];
  const otherReferences: UnresolvedReference[] = [];
  for (const input of parsedInputs) {
    for (const reference of input.parsedFile.unresolvedReferences) {
      if (reference.kind === "import" || (reference.kind === "export" && reference.name.startsWith("."))) {
        importReferences.push(reference);
      } else {
        otherReferences.push(reference);
      }
    }
  }

  let unresolved = 0;
  let ambiguous = 0;
  const edgeIds = new Set<string>();

  for (const reference of importReferences) {
    const candidates = moduleCandidates(
      reference,
      modulesByFile,
      projectResolver,
      pythonModules,
    );
    if (candidates.length === 0) {
      persistIssue(database, reference, "unresolved_reference", [], timestamp);
      unresolved += 1;
      continue;
    }
    if (candidates.length > 1) {
      persistIssue(database, reference, "multi_candidate", candidates, timestamp);
      ambiguous += 1;
    }
    const importReference = reference.kind === "export" ? { ...reference, kind: "import" as const } : reference;
    persistEdges(
      database,
      repositoryId,
      importReference,
      candidates,
      true,
      modulesByFile,
      null,
      timestamp,
      edgeIds,
    );
    if (reference.localName !== null && reference.importedName !== null) {
      const bindings = bindingsByFile.get(reference.evidence.file) ?? [];
      for (const candidate of candidates) {
        if (candidate.filePath === null) continue;
        bindings.push({
          localName: reference.localName,
          importedName: reference.importedName,
          targetFilePath: candidate.filePath,
        });
      }
      bindingsByFile.set(reference.evidence.file, bindings);
    }
  }

  const distances = new ImportDistanceIndex(database, modulesByFile, nodeById);
  for (const reference of otherReferences) {
    const source = nodeById.get(reference.sourceNodeId);
    if (source === undefined) continue;
    const candidates = symbolCandidates(
      reference,
      source,
      indexes,
      bindingsByFile.get(reference.evidence.file) ?? [],
      exportedNodeIds,
      modulesByFile,
      distances,
      projectResolver,
    );
    if (candidates.nodes.length === 0) {
      persistIssue(
        database,
        reference,
        reference.kind === "generated"
          ? "generated_code"
          : DYNAMIC_REFERENCE_KINDS.has(reference.kind)
            ? "dynamic_relationship"
            : "unresolved_reference",
        [],
        timestamp,
      );
      unresolved += 1;
      continue;
    }
    if (candidates.nodes.length > 1) {
      persistIssue(
        database,
        reference,
        DYNAMIC_REFERENCE_KINDS.has(reference.kind)
          ? "dynamic_relationship"
          : "multi_candidate",
        candidates.nodes,
        timestamp,
      );
      ambiguous += 1;
    }
    persistEdges(
      database,
      repositoryId,
      reference,
      candidates.nodes,
      candidates.exact,
      modulesByFile,
      distances,
      timestamp,
      edgeIds,
      candidates.sourceType,
    );
  }

  return { edges: edgeIds.size, unresolved, ambiguous };
}
