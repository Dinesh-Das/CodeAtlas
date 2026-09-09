import type { GraphEdge, GraphNode } from "../graph/types.js";
import { containerNodeId, frameworkEdge, frameworkNode } from "./graph.js";
import type { FrameworkAdapter, FrameworkEntities, RepositoryContext } from "./types.js";

interface EnvironmentReference {
  name: string;
  line: number;
  column: number;
  access: string;
}

const analyses = new WeakMap<RepositoryContext, EnvironmentReference[]>();

function analyze(context: RepositoryContext): EnvironmentReference[] {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const found = new Map<string, EnvironmentReference>();
  const patterns = [
    { access: "process.env", expression: /process\.env\.([A-Z][A-Z0-9_]*)/gu },
    { access: "process.env", expression: /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/gu },
    { access: "os.getenv", expression: /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/gu },
    { access: "os.environ", expression: /os\.environ\[['"]([A-Z][A-Z0-9_]*)['"]\]/gu },
  ];
  for (const pattern of patterns) {
    for (const match of context.content.matchAll(pattern.expression)) {
      const name = match[1];
      if (name === undefined || found.has(name)) continue;
      const offset = match.index ?? 0;
      const lineStart = context.content.lastIndexOf("\n", offset) + 1;
      found.set(name, {
        name,
        line: context.content.slice(0, offset).split(/\r?\n/u).length,
        column: offset - lineStart,
        access: pattern.access,
      });
    }
  }
  const result = [...found.values()].sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
  analyses.set(context, result);
  return result;
}

function environmentNode(context: RepositoryContext, reference: EnvironmentReference): GraphNode {
  return frameworkNode(context, {
    kind: "environment_variable",
    name: reference.name,
    qualifiedName: `environment:${reference.name}`,
    location: {
      line: reference.line,
      column: reference.column,
      endLine: reference.line,
      endColumn: reference.column + reference.name.length,
    },
    framework: "environment",
    sourceType: "config",
    metadata: { environment_entity: "variable", access: reference.access },
  });
}

export const environmentAdapter: FrameworkAdapter = {
  name: "environment",
  version: "environment-reference-1",

  supports(_relativeFilePath, language) {
    return ["typescript", "tsx", "javascript", "jsx", "python"].includes(language ?? "");
  },

  detect(context) {
    return analyze(context).length > 0;
  },

  extractRoutes() {
    return [];
  },

  extractModels(context) {
    return analyze(context).map((reference) => environmentNode(context, reference));
  },

  extractFrameworkRelationships(context, entities: FrameworkEntities): GraphEdge[] {
    return entities.models.map((item) => frameworkEdge(context, {
      edgeType: "REFERENCES",
      sourceNodeId: containerNodeId(context),
      targetNodeId: item.id,
      location: { line: item.startLine ?? 1, column: item.startColumn ?? 0 },
      sourceType: "config",
      metadata: { framework: "environment", configuration_evidence: true },
    }));
  },
};
