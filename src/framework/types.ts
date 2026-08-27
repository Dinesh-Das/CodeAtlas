import type { DetectedLanguage } from "../core/languages.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { ParsedFile } from "../parser/parser.js";

export interface RepositoryContext {
  repositoryId: string;
  repositoryRoot: string;
  relativeFilePath: string;
  language: DetectedLanguage | null;
  content: string;
  contentHash: string;
  parsedFile: ParsedFile | null;
}

export interface FrameworkEntities {
  routes: GraphNode[];
  models: GraphNode[];
}

export interface FrameworkAdapter {
  readonly name: string;
  readonly version: string;
  supports(relativeFilePath: string, language: DetectedLanguage | null): boolean;
  detect(context: RepositoryContext): boolean;
  extractRoutes(context: RepositoryContext): GraphNode[];
  extractModels(context: RepositoryContext): GraphNode[];
  extractFrameworkRelationships(
    context: RepositoryContext,
    entities: FrameworkEntities,
  ): GraphEdge[];
}

export interface FrameworkExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
  detectedFrameworks: string[];
  failures: Array<{
    adapter: string;
    message: string;
  }>;
}
