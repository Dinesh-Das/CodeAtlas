import path from "node:path";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { containerNodeId, frameworkEdge, frameworkNode } from "./graph.js";
import type {
  FrameworkAdapter,
  FrameworkEntities,
  RepositoryContext,
} from "./types.js";

interface PrismaField {
  name: string;
  type: string;
  line: number;
  column: number;
}

interface PrismaModel {
  name: string;
  line: number;
  column: number;
  endLine: number;
  fields: PrismaField[];
}

const analyses = new WeakMap<RepositoryContext, PrismaModel[]>();

function analyze(context: RepositoryContext): PrismaModel[] {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const lines = context.content.split(/\r?\n/u);
  const models: PrismaModel[] = [];
  let current: PrismaModel | null = null;
  for (const [index, line] of lines.entries()) {
    if (current === null) {
      const match = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/u.exec(line);
      if (match !== null) {
        current = {
          name: match[1]!,
          line: index + 1,
          column: line.indexOf("model"),
          endLine: index + 1,
          fields: [],
        };
      }
      continue;
    }
    if (/^\s*\}/u.test(line)) {
      current.endLine = index + 1;
      models.push(current);
      current = null;
      continue;
    }
    if (/^\s*(?:\/\/|@@|$)/u.test(line)) continue;
    const field = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*(?:\[\])?\??)/u.exec(
      line,
    );
    if (field !== null) {
      current.fields.push({
        name: field[1]!,
        type: field[2]!,
        line: index + 1,
        column: line.indexOf(field[1]!),
      });
    }
  }
  if (current !== null) models.push(current);
  analyses.set(context, models);
  return models;
}

function modelNode(context: RepositoryContext, model: PrismaModel): GraphNode {
  return frameworkNode(context, {
    kind: "database_model",
    name: model.name,
    qualifiedName: model.name,
    location: {
      line: model.line,
      column: model.column,
      endLine: model.endLine,
      endColumn: 1,
    },
    framework: "prisma",
    sourceType: "schema",
    signature: `model ${model.name}`,
    metadata: {
      field_count: model.fields.length,
      fields: model.fields.map((field) => ({ name: field.name, type: field.type })),
    },
  });
}

export const prismaAdapter: FrameworkAdapter = {
  name: "prisma",
  version: "prisma-framework-1",

  supports(relativeFilePath) {
    return path.posix.extname(relativeFilePath).toLowerCase() === ".prisma";
  },

  detect(context) {
    return analyze(context).length > 0;
  },

  extractRoutes() {
    return [];
  },

  extractModels(context) {
    return analyze(context).map((model) => modelNode(context, model));
  },

  extractFrameworkRelationships(context, entities: FrameworkEntities): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const models = analyze(context);
    const nodesByName = new Map(entities.models.map((node) => [node.name, node]));
    for (const [index, node] of entities.models.entries()) {
      const model = models[index];
      if (model === undefined) continue;
      edges.push(
        frameworkEdge(context, {
          edgeType: "CONTAINS",
          sourceNodeId: containerNodeId(context),
          targetNodeId: node.id,
          location: { line: model.line, column: model.column },
          sourceType: "schema",
          metadata: { framework: "prisma" },
        }),
      );
      for (const field of model.fields) {
        const targetName = field.type.replace(/[?\[\]]/gu, "");
        const target = nodesByName.get(targetName);
        if (target === undefined || target.id === node.id) continue;
        edges.push(
          frameworkEdge(context, {
            edgeType: "REFERENCES",
            sourceNodeId: node.id,
            targetNodeId: target.id,
            location: { line: field.line, column: field.column },
            sourceType: "schema",
            metadata: { framework: "prisma", field: field.name },
          }),
        );
      }
    }
    return edges;
  },
};
