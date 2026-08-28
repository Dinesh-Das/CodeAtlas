import type { DetectedLanguage } from "../core/languages.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { ParsedFile } from "../parser/parser.js";
import { expressAdapter } from "./express.js";
import { fastApiAdapter } from "./fastapi.js";
import { fastifyAdapter } from "./fastify.js";
import { prismaAdapter } from "./prisma.js";
import { sqlAlchemyAdapter } from "./sqlalchemy.js";
import type {
  FrameworkAdapter,
  FrameworkExtraction,
  RepositoryContext,
} from "./types.js";

const adapters = new Map<string, FrameworkAdapter>();

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
  adapters.set(adapter.name, adapter);
  return () => {
    if (adapters.get(adapter.name) === adapter) adapters.delete(adapter.name);
  };
}

for (const adapter of [expressAdapter, fastApiAdapter, fastifyAdapter, prismaAdapter, sqlAlchemyAdapter]) {
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
      nodes.push(...entities.routes, ...entities.models, ...entities.supporting);
      edges.push(...adapter.extractFrameworkRelationships(context, entities));
      references.push(...(adapter.extractFrameworkReferences?.(context, entities) ?? []));
      suppressedReferences.push(...(adapter.suppressedReferences?.(context) ?? []));
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
  return [...adapters.values()];
}
