import type { DetectedLanguage } from "../core/languages.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { EDGE_TYPES, NODE_KINDS, PROVENANCE_CATEGORIES, SOURCE_TYPES } from "../graph/types.js";
import type { ParsedFile } from "../parser/parser.js";
import { expressAdapter } from "./express.js";
import { asyncApiAdapter } from "./asyncapi.js";
import { deploymentAdapter } from "./deployment.js";
import { environmentAdapter } from "./environment.js";
import { fastApiAdapter } from "./fastapi.js";
import { fastifyAdapter } from "./fastify.js";
import { prismaAdapter } from "./prisma.js";
import { sqlAlchemyAdapter } from "./sqlalchemy.js";
import { openApiAdapter } from "./openapi.js";
import { runtimeEvidenceAdapter } from "./runtime-evidence.js";
import type {
  FrameworkAdapter,
  FrameworkExtraction,
  RepositoryContext,
} from "./types.js";

const adapters = new Map<string, FrameworkAdapter>();

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must return an array.`);
}

function assertConfidence(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} confidence must be between 0 and 1.`);
  }
}

function assertEvidenceFile(
  metadata: Readonly<Record<string, unknown>>,
  expectedFile: string,
  label: string,
): void {
  const evidence = metadata.evidence;
  if (typeof evidence !== "object" || evidence === null) {
    throw new Error(`${label} must include evidence metadata.`);
  }
  const file = (evidence as Record<string, unknown>).file;
  const line = (evidence as Record<string, unknown>).line;
  if (file !== expectedFile || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    throw new Error(`${label} evidence must point to a positive line in ${expectedFile}.`);
  }
}

function validateAdapterExtraction(
  adapter: FrameworkAdapter,
  context: RepositoryContext,
  entities: FrameworkExtraction["nodes"],
  edges: FrameworkExtraction["edges"],
  references: FrameworkExtraction["references"],
  suppressedReferences: FrameworkExtraction["suppressedReferences"],
): void {
  assertArray(entities, `${adapter.name} node extraction`);
  assertArray(edges, `${adapter.name} relationship extraction`);
  assertArray(references, `${adapter.name} reference extraction`);
  assertArray(suppressedReferences, `${adapter.name} suppression extraction`);
  const nodeIds = new Set<string>();
  for (const [index, node] of entities.entries()) {
    const label = `${adapter.name} node ${index}`;
    if (typeof node.id !== "string" || node.id === "" || nodeIds.has(node.id)) {
      throw new Error(`${label} must have a unique non-empty ID.`);
    }
    nodeIds.add(node.id);
    if (!NODE_KINDS.includes(node.kind)) throw new Error(`${label} has an unsupported kind.`);
    if (!SOURCE_TYPES.includes(node.sourceType)) throw new Error(`${label} has an unsupported source type.`);
    if (!PROVENANCE_CATEGORIES.includes(node.provenance)) {
      throw new Error(`${label} has an unsupported provenance category.`);
    }
    if (node.filePath !== context.relativeFilePath) {
      throw new Error(`${label} must be owned by ${context.relativeFilePath}.`);
    }
    assertConfidence(node.confidence, label);
    assertEvidenceFile(node.metadata, context.relativeFilePath, label);
  }
  const edgeIds = new Set<string>();
  for (const [index, edge] of edges.entries()) {
    const label = `${adapter.name} edge ${index}`;
    if (typeof edge.id !== "string" || edge.id === "" || edgeIds.has(edge.id)) {
      throw new Error(`${label} must have a unique non-empty ID.`);
    }
    edgeIds.add(edge.id);
    if (!EDGE_TYPES.includes(edge.edgeType)) throw new Error(`${label} has an unsupported type.`);
    if (!SOURCE_TYPES.includes(edge.sourceType)) throw new Error(`${label} has an unsupported source type.`);
    if (!PROVENANCE_CATEGORIES.includes(edge.provenance)) {
      throw new Error(`${label} has an unsupported provenance category.`);
    }
    if (edge.filePath !== context.relativeFilePath) {
      throw new Error(`${label} must be owned by ${context.relativeFilePath}.`);
    }
    assertConfidence(edge.confidence, label);
    assertEvidenceFile(edge.metadata, context.relativeFilePath, label);
  }
  for (const [index, reference] of references.entries()) {
    const label = `${adapter.name} reference ${index}`;
    if (reference.name.trim() === "") throw new Error(`${label} must name a target.`);
    if (reference.evidence.file !== context.relativeFilePath || reference.evidence.line < 1) {
      throw new Error(`${label} evidence must point to ${context.relativeFilePath}.`);
    }
    assertConfidence(reference.confidence, label);
  }
  for (const [index, reference] of suppressedReferences.entries()) {
    if (!Number.isInteger(reference.line) || reference.line < 1 ||
        !Number.isInteger(reference.column) || reference.column < 0) {
      throw new Error(`${adapter.name} suppression ${index} has an invalid source location.`);
    }
  }
}

export function registerFrameworkAdapter(
  adapter: FrameworkAdapter,
  options: { replace?: boolean } = {},
): () => void {
  if (adapter.name.trim() === "" || adapter.version.trim() === "") {
    throw new Error("Framework adapters require non-empty name and version values.");
  }
  if (adapters.has(adapter.name) && options.replace !== true) {
    throw new Error(`Framework adapter ${adapter.name} is already registered.`);
  }
  const previous = adapters.get(adapter.name);
  adapters.set(adapter.name, adapter);
  return () => {
    if (adapters.get(adapter.name) !== adapter) return;
    if (previous === undefined) adapters.delete(adapter.name);
    else adapters.set(adapter.name, previous);
  };
}

for (const adapter of [
  asyncApiAdapter,
  deploymentAdapter,
  environmentAdapter,
  expressAdapter,
  fastApiAdapter,
  fastifyAdapter,
  openApiAdapter,
  runtimeEvidenceAdapter,
  prismaAdapter,
  sqlAlchemyAdapter,
]) {
  registerFrameworkAdapter(adapter);
}

export function supportsFrameworkExtraction(
  relativeFilePath: string,
  language: DetectedLanguage | null,
): boolean {
  for (const adapter of adapters.values()) {
    try {
      if (adapter.supports(relativeFilePath, language)) return true;
    } catch {
      // A faulty optional adapter must not disable generic AST analysis.
    }
  }
  return false;
}

export function extractFrameworkGraph(
  context: RepositoryContext,
): FrameworkExtraction {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const references: FrameworkExtraction["references"] = [];
  const suppressedReferences: FrameworkExtraction["suppressedReferences"] = [];
  const detectedFrameworks: string[] = [];
  const failures: FrameworkExtraction["failures"] = [];
  for (const adapter of adapters.values()) {
    try {
      if (!adapter.supports(context.relativeFilePath, context.language)) continue;
      if (!adapter.detect(context)) continue;
      const entities = {
        routes: adapter.extractRoutes(context),
        models: adapter.extractModels(context),
        supporting: adapter.extractSupportingNodes?.(context) ?? [],
      };
      const adapterNodes = [...entities.routes, ...entities.models, ...entities.supporting];
      const adapterEdges = adapter.extractFrameworkRelationships(context, entities);
      const adapterReferences = adapter.extractFrameworkReferences?.(context, entities) ?? [];
      const adapterSuppressions = adapter.suppressedReferences?.(context) ?? [];
      validateAdapterExtraction(
        adapter,
        context,
        adapterNodes,
        adapterEdges,
        adapterReferences,
        adapterSuppressions,
      );
      nodes.push(...adapterNodes);
      edges.push(...adapterEdges);
      references.push(...adapterReferences);
      suppressedReferences.push(...adapterSuppressions);
      detectedFrameworks.push(adapter.name);
    } catch (error) {
      failures.push({
        adapter: adapter.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    nodes,
    edges,
    references,
    suppressedReferences,
    detectedFrameworks: detectedFrameworks.sort((left, right) => left.localeCompare(right)),
    failures,
  };
}

export function mergeFrameworkGraph(
  parsedFile: ParsedFile | null,
  extraction: FrameworkExtraction,
): ParsedFile | null {
  if (
    parsedFile === null &&
    extraction.nodes.length === 0 &&
    extraction.edges.length === 0 &&
    extraction.references.length === 0 &&
    extraction.failures.length === 0
  ) {
    return null;
  }
  const base: ParsedFile = parsedFile ?? {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [],
  };
  const nodes = new Map(base.nodes.map((node) => [node.id, node]));
  const edges = new Map(base.edges.map((edge) => [edge.id, edge]));
  for (const node of extraction.nodes) nodes.set(node.id, node);
  for (const edge of extraction.edges) edges.set(edge.id, edge);
  const suppressed = new Set(
    extraction.suppressedReferences.map(
      (reference) => `${reference.kind}\0${reference.line}\0${reference.column}`,
    ),
  );
  return {
    ...base,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    unresolvedReferences: [
      ...base.unresolvedReferences.filter(
        (reference) =>
          !suppressed.has(
            `${reference.kind}\0${reference.evidence.line}\0${reference.evidence.column}`,
          ),
      ),
      ...extraction.references,
    ],
    errors: [
      ...base.errors,
      ...extraction.failures.map((failure) => ({
        message: `Framework adapter ${failure.adapter} failed; generic AST analysis was retained: ${failure.message}`,
        severity: "warning" as const,
        evidence: {
          sourceType: "framework" as const,
          file: base.nodes[0]?.filePath ?? ".",
          line: 1,
          column: 0,
        },
      })),
    ],
  };
}

export function availableFrameworkAdapters(): readonly FrameworkAdapter[] {
  return [...adapters.values()].sort((left, right) => left.name.localeCompare(right.name));
}
