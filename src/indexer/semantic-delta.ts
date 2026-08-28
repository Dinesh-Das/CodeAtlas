import { sha256 } from "../core/hashing.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { ParsedFile, UnresolvedReference } from "../parser/parser.js";
import type { CompilerPublicApiFacts } from "../graph/typescript-resolution.js";

export type SemanticChangeClass =
  | "content_only"
  | "implementation_only"
  | "outgoing_change"
  | "public_contract_change"
  | "module_resolution_change"
  | "added"
  | "deleted"
  | "renamed";

export interface ExportedSemanticSymbol {
  id: string;
  name: string;
  fingerprint: string;
}

export interface FileSemanticFacts {
  path: string;
  tokenFingerprint: string;
  symbolsFingerprint: string;
  importsFingerprint: string;
  exportsFingerprint: string;
  referencesFingerprint: string;
  publicApiFingerprint: string;
  frameworkFingerprint: string;
  architectureFingerprint: string;
  searchFingerprint: string;
  exportedSymbols: ExportedSemanticSymbol[];
  references: UnresolvedReference[];
}

export interface SemanticDelta {
  path: string;
  changeClass: SemanticChangeClass;
  graphChanged: boolean;
  semanticChanged: boolean;
  searchChanged: boolean;
  architectureChanged: boolean;
  outgoingChanged: boolean;
  publicContractChanged: boolean;
  changedExportNodeIds: string[];
  changedExportNames: string[];
}

const POSITIONAL_METADATA = new Set([
  "evidence",
  "line",
  "column",
  "start_line",
  "start_column",
  "end_line",
  "end_column",
  "content_hash",
  "size_bytes",
]);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !POSITIONAL_METADATA.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function fingerprint(entries: readonly unknown[]): string {
  return sha256(entries.map(canonicalJson).sort((left, right) => left.localeCompare(right)).join("\n"));
}

function semanticNode(node: GraphNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    language: node.language,
    signature:
      node.signature === null ? null : semanticTokenStream(node.signature, node.language),
    visibility: node.visibility,
    sourceType: node.sourceType,
    provenance: node.provenance,
    confidence: node.confidence,
    metadata: canonicalValue(node.metadata),
  };
}

function semanticEdge(edge: GraphEdge): Record<string, unknown> {
  return {
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    edgeType: edge.edgeType,
    sourceType: edge.sourceType,
    provenance: edge.provenance,
    confidence: edge.confidence,
    metadata: canonicalValue(edge.metadata),
  };
}

export function semanticReferenceIdentity(reference: UnresolvedReference): string {
  return canonicalJson({
    name: reference.name,
    kind: reference.kind,
    sourceNodeId: reference.sourceNodeId,
    localName: reference.localName,
    importedName: reference.importedName,
    provenance: reference.provenance,
    confidence: reference.confidence,
    metadata: canonicalValue(reference.metadata),
  });
}

function semanticTokenStream(content: string, language: string | null): string {
  if (language === "json") {
    try {
      return canonicalJson(JSON.parse(content) as unknown);
    } catch {
      // Invalid JSON is still indexed; use the conservative scanner below.
    }
  }

  let output = "";
  let word = "";
  let index = 0;
  let quote: "'" | '"' | "`" | null = null;
  const flushWord = (): void => {
    if (word !== "") output += ` ${word}`;
    word = "";
  };
  while (index < content.length) {
    const current = content[index]!;
    const next = content[index + 1] ?? "";
    if (quote !== null) {
      output += current;
      if (current === "\\") {
        output += next;
        index += 2;
        continue;
      }
      if (current === quote) quote = null;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      flushWord();
      quote = current;
      output += current;
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      flushWord();
      index += 2;
      while (index < content.length && content[index] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      flushWord();
      index += 2;
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(content.length, index + 2);
      continue;
    }
    if (language === "python" && current === "#") {
      flushWord();
      index += 1;
      while (index < content.length && content[index] !== "\n") index += 1;
      continue;
    }
    if (/\s/u.test(current)) {
      flushWord();
      index += 1;
      continue;
    }
    if (/[\p{L}\p{N}_$]/u.test(current)) {
      word += current;
    } else {
      flushWord();
      output += current;
    }
    index += 1;
  }
  flushWord();
  return output.trim();
}

function publicContractFor(
  target: GraphNode,
  nodesById: ReadonlyMap<string, GraphNode>,
  childrenById: ReadonlyMap<string, readonly string[]>,
): unknown[] {
  const result: unknown[] = [semanticNode(target)];
  if (target.kind !== "class" && target.kind !== "interface") return result;
  for (const id of childrenById.get(target.id) ?? []) {
    const node = nodesById.get(id);
    if (
      node !== undefined &&
      node.visibility !== "private" &&
      node.visibility !== "local" &&
      node.visibility !== "module"
    ) {
      result.push(semanticNode(node));
    }
  }
  return result;
}

export function buildFileSemanticFacts(
  filePath: string,
  language: string | null,
  content: string,
  parsedFile: ParsedFile | null,
  compilerPublicApi: CompilerPublicApiFacts | null = null,
): FileSemanticFacts {
  const nodes = parsedFile?.nodes ?? [];
  const edges = parsedFile?.edges ?? [];
  const references = parsedFile?.unresolvedReferences ?? [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const childrenById = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.edgeType !== "CONTAINS") continue;
    const children = childrenById.get(edge.sourceNodeId) ?? [];
    children.push(edge.targetNodeId);
    childrenById.set(edge.sourceNodeId, children);
  }
  const exportTargets = edges
    .filter((edge) => edge.edgeType === "EXPORTS")
    .map((edge) => nodesById.get(edge.targetNodeId))
    .filter((node): node is GraphNode => node !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const publicContracts = new Map(
    exportTargets.map((node) => [node.id, publicContractFor(node, nodesById, childrenById)]),
  );
  const exportedSymbols = exportTargets.map((node) => ({
    id: node.id,
    name: node.name,
    fingerprint: fingerprint([
      fingerprint(publicContracts.get(node.id) ?? [semanticNode(node)]),
      compilerPublicApi?.exportedSymbols[node.name] ?? null,
    ]),
  }));
  const importReferences = references.filter(
    (reference) => reference.kind === "import" || reference.kind === "export",
  );
  const outgoingReferences = references.filter(
    (reference) => reference.kind !== "import" && reference.kind !== "export",
  );
  const semanticNodes = nodes.map(semanticNode);
  const frameworkNodes = nodes.filter((node) =>
    ["framework", "schema", "config"].includes(node.sourceType),
  );
  const frameworkEdges = edges.filter((edge) =>
    ["framework", "schema", "config"].includes(edge.sourceType),
  );
  const architectureNodes = nodes.filter((node) =>
    ["module", "api_route", "database_model", "database_table", "configuration", "external_service", "event", "queue"].includes(node.kind),
  );
  const architectureReferences = references.map(semanticReferenceIdentity);

  return {
    path: filePath,
    tokenFingerprint: sha256(semanticTokenStream(content, language)),
    symbolsFingerprint: fingerprint(semanticNodes),
    importsFingerprint: fingerprint(importReferences.map(semanticReferenceIdentity)),
    exportsFingerprint: fingerprint([
      ...edges.filter((edge) => edge.edgeType === "EXPORTS").map(semanticEdge),
      ...references.filter((reference) => reference.kind === "export").map(semanticReferenceIdentity),
    ]),
    referencesFingerprint: fingerprint(outgoingReferences.map(semanticReferenceIdentity)),
    publicApiFingerprint: fingerprint([
      fingerprint([...publicContracts.values()].flat()),
      compilerPublicApi?.fingerprint ?? null,
    ]),
    frameworkFingerprint: fingerprint([
      ...frameworkNodes.map(semanticNode),
      ...frameworkEdges.map(semanticEdge),
    ]),
    architectureFingerprint: fingerprint([
      ...architectureNodes.map(semanticNode),
      ...architectureReferences,
    ]),
    searchFingerprint: fingerprint(nodes.map((node) => ({
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      signature:
        node.signature === null ? null : semanticTokenStream(node.signature, node.language),
      metadata: canonicalValue(node.metadata),
    }))),
    exportedSymbols,
    references,
  };
}

function changedExports(
  previous: FileSemanticFacts,
  current: FileSemanticFacts,
): { ids: string[]; names: string[] } {
  const previousById = new Map(previous.exportedSymbols.map((entry) => [entry.id, entry]));
  const currentById = new Map(current.exportedSymbols.map((entry) => [entry.id, entry]));
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const entry of previous.exportedSymbols) {
    if (currentById.get(entry.id)?.fingerprint !== entry.fingerprint) {
      ids.add(entry.id);
      names.add(entry.name);
    }
  }
  for (const entry of current.exportedSymbols) {
    if (previousById.get(entry.id)?.fingerprint !== entry.fingerprint) {
      ids.add(entry.id);
      names.add(entry.name);
    }
  }
  return {
    ids: [...ids].sort((left, right) => left.localeCompare(right)),
    names: [...names].sort((left, right) => left.localeCompare(right)),
  };
}

export function classifySemanticDelta(
  previous: FileSemanticFacts | null,
  current: FileSemanticFacts | null,
  forcedClass?: "module_resolution_change" | "renamed",
): SemanticDelta {
  const path = current?.path ?? previous?.path ?? "";
  if (previous === null && current === null) throw new Error("A semantic delta requires facts.");
  if (previous === null) {
    return {
      path,
      changeClass: forcedClass ?? "added",
      graphChanged: true,
      semanticChanged: true,
      searchChanged: true,
      architectureChanged: true,
      outgoingChanged: true,
      publicContractChanged: current!.exportedSymbols.length > 0,
      changedExportNodeIds: current!.exportedSymbols.map((entry) => entry.id),
      changedExportNames: current!.exportedSymbols.map((entry) => entry.name),
    };
  }
  if (current === null) {
    return {
      path,
      changeClass: forcedClass ?? "deleted",
      graphChanged: true,
      semanticChanged: true,
      searchChanged: true,
      architectureChanged: true,
      outgoingChanged: true,
      publicContractChanged: previous.exportedSymbols.length > 0,
      changedExportNodeIds: previous.exportedSymbols.map((entry) => entry.id),
      changedExportNames: previous.exportedSymbols.map((entry) => entry.name),
    };
  }

  const exports = changedExports(previous, current);
  const publicContractChanged =
    previous.exportsFingerprint !== current.exportsFingerprint ||
    previous.publicApiFingerprint !== current.publicApiFingerprint;
  const outgoingChanged =
    previous.importsFingerprint !== current.importsFingerprint ||
    previous.referencesFingerprint !== current.referencesFingerprint;
  const graphChanged =
    previous.symbolsFingerprint !== current.symbolsFingerprint ||
    outgoingChanged ||
    publicContractChanged ||
    previous.frameworkFingerprint !== current.frameworkFingerprint;
  const searchChanged = previous.searchFingerprint !== current.searchFingerprint;
  const architectureChanged =
    previous.architectureFingerprint !== current.architectureFingerprint ||
    outgoingChanged ||
    publicContractChanged;
  const changeClass: SemanticChangeClass = forcedClass ?? (
    publicContractChanged
      ? "public_contract_change"
      : outgoingChanged
        ? "outgoing_change"
        : graphChanged || previous.tokenFingerprint !== current.tokenFingerprint
          ? "implementation_only"
          : "content_only"
  );
  return {
    path,
    changeClass,
    graphChanged,
    semanticChanged: graphChanged,
    searchChanged,
    architectureChanged,
    outgoingChanged,
    publicContractChanged,
    changedExportNodeIds: exports.ids,
    changedExportNames: exports.names,
  };
}

export function isModuleResolutionConfiguration(filePath: string): boolean {
  const name = filePath.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    name === "package.json" ||
    name === "tsconfig.json" ||
    name === "jsconfig.json" ||
    /^tsconfig\..+\.json$/u.test(name) ||
    /^jsconfig\..+\.json$/u.test(name)
  );
}
