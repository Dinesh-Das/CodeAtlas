import type { DetectedLanguage } from "../core/languages.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { ParsedFile } from "../parser/parser.js";
import { expressAdapter } from "./express.js";
import { fastApiAdapter } from "./fastapi.js";
import { prismaAdapter } from "./prisma.js";
import { sqlAlchemyAdapter } from "./sqlalchemy.js";
import type {
  FrameworkAdapter,
  FrameworkExtraction,
  RepositoryContext,
} from "./types.js";

const adapters: readonly FrameworkAdapter[] = [
  expressAdapter,
  fastApiAdapter,
  prismaAdapter,
  sqlAlchemyAdapter,
];

export function supportsFrameworkExtraction(
  relativeFilePath: string,
  language: DetectedLanguage | null,
): boolean {
  return adapters.some((adapter) => adapter.supports(relativeFilePath, language));
}

export function extractFrameworkGraph(
  context: RepositoryContext,
): FrameworkExtraction {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const detectedFrameworks: string[] = [];
  for (const adapter of adapters) {
    if (!adapter.supports(context.relativeFilePath, context.language)) continue;
    if (!adapter.detect(context)) continue;
    detectedFrameworks.push(adapter.name);
    const entities = {
      routes: adapter.extractRoutes(context),
      models: adapter.extractModels(context),
    };
    nodes.push(...entities.routes, ...entities.models);
    edges.push(...adapter.extractFrameworkRelationships(context, entities));
  }
  return {
    nodes,
    edges,
    detectedFrameworks: detectedFrameworks.sort((left, right) => left.localeCompare(right)),
  };
}

export function mergeFrameworkGraph(
  parsedFile: ParsedFile | null,
  extraction: FrameworkExtraction,
): ParsedFile | null {
  if (parsedFile === null && extraction.nodes.length === 0 && extraction.edges.length === 0) {
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
  return {
    ...base,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

export function availableFrameworkAdapters(): readonly FrameworkAdapter[] {
  return adapters;
}
