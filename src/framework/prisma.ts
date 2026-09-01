import path from "node:path";
import JavaScriptLanguage from "tree-sitter-javascript";
import TypeScriptLanguages from "tree-sitter-typescript";
import type { DetectedLanguage } from "../core/languages.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { UnresolvedReference } from "../parser/parser.js";
import { createTree, type SyntaxNode } from "../parser/tree-sitter.js";
import { containerNodeId, frameworkEdge, frameworkNode, locationFor } from "./graph.js";
import { identifierText, memberParts, walkSyntax } from "./syntax.js";
import type {
  FrameworkAdapter,
  FrameworkEntities,
  RepositoryContext,
  SuppressedFrameworkReference,
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

interface PrismaOperation {
  syntaxNode: SyntaxNode;
  callableNode: SyntaxNode;
  modelAccessor: string;
  modelName: string;
  operation: string;
  kind: "prisma_query" | "prisma_update";
  sourceNodeId: string;
}

interface PrismaCodeAnalysis {
  operations: PrismaOperation[];
  suppressedReferences: SuppressedFrameworkReference[];
}

const READ_OPERATIONS = new Set([
  "aggregate",
  "count",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
]);
const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

const schemaAnalyses = new WeakMap<RepositoryContext, PrismaModel[]>();
const codeAnalyses = new WeakMap<RepositoryContext, PrismaCodeAnalysis>();

function analyzeSchema(context: RepositoryContext): PrismaModel[] {
  const cached = schemaAnalyses.get(context);
  if (cached !== undefined) return cached;
  if (path.posix.extname(context.relativeFilePath).toLowerCase() !== ".prisma") {
    schemaAnalyses.set(context, []);
    return [];
  }
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
  schemaAnalyses.set(context, models);
  return models;
}

function grammarFor(language: DetectedLanguage | null): unknown {
  if (language === "typescript") return TypeScriptLanguages.typescript;
  if (language === "tsx") return TypeScriptLanguages.tsx;
  return JavaScriptLanguage;
}

function enclosingCallableNodeId(context: RepositoryContext, syntaxNode: SyntaxNode): string {
  const line = syntaxNode.startPosition.row + 1;
  const candidates = (context.parsedFile?.nodes ?? []).filter(
    (node) =>
      (node.kind === "function" || node.kind === "method") &&
      node.startLine !== null &&
      node.endLine !== null &&
      node.startLine <= line &&
      node.endLine >= line,
  );
  candidates.sort(
    (left, right) =>
      (left.endLine! - left.startLine!) - (right.endLine! - right.startLine!),
  );
  return candidates[0]?.id ?? containerNodeId(context);
}

function prismaModelName(accessor: string): string {
  return accessor.length === 0 ? accessor : `${accessor[0]!.toUpperCase()}${accessor.slice(1)}`;
}

function analyzeCode(context: RepositoryContext): PrismaCodeAnalysis {
  const cached = codeAnalyses.get(context);
  if (cached !== undefined) return cached;
  if (!["typescript", "tsx", "javascript", "jsx"].includes(context.language ?? "")) {
    const empty = { operations: [], suppressedReferences: [] };
    codeAnalyses.set(context, empty);
    return empty;
  }
  const root = createTree(grammarFor(context.language), context.content).rootNode;
  const clientNames = new Set(["prisma"]);
  walkSyntax(root, (node) => {
    if (node.type !== "variable_declarator") return;
    const name = identifierText(node.childForFieldName("name"));
    const value = node.childForFieldName("value");
    if (name === null || value?.type !== "new_expression") return;
    const constructor = memberParts(value.childForFieldName("constructor"));
    if (constructor?.at(-1) === "PrismaClient") clientNames.add(name);
  });

  const operations: PrismaOperation[] = [];
  const suppressedReferences: SuppressedFrameworkReference[] = [];
  walkSyntax(root, (node) => {
    if (node.type !== "call_expression") return;
    const callableNode = node.childForFieldName("function");
    const parts = memberParts(callableNode);
    if (callableNode === null || parts === null || parts.length < 3) return;
    const operation = parts.at(-1)!;
    const kind = READ_OPERATIONS.has(operation)
      ? "prisma_query" as const
      : WRITE_OPERATIONS.has(operation)
        ? "prisma_update" as const
        : null;
    if (kind === null) return;
    const modelAccessor = parts.at(-2)!;
    const receiverParts = parts.slice(0, -2);
    const looksLikePrisma = receiverParts.some(
      (part) => clientNames.has(part) || part.toLowerCase() === "prisma",
    );
    if (!looksLikePrisma) return;
    const location = locationFor(callableNode);
    operations.push({
      syntaxNode: node,
      callableNode,
      modelAccessor,
      modelName: prismaModelName(modelAccessor),
      operation,
      kind,
      sourceNodeId: enclosingCallableNodeId(context, node),
    });
    suppressedReferences.push({
      kind: "call",
      line: location.line,
      column: location.column,
    });
  });
  const result = { operations, suppressedReferences };
  codeAnalyses.set(context, result);
  return result;
}

function modelNode(context: RepositoryContext, model: PrismaModel): GraphNode {
  const clientAccessor = `${model.name[0]?.toLowerCase() ?? ""}${model.name.slice(1)}`;
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
      client_accessor: clientAccessor,
      field_count: model.fields.length,
      fields: model.fields.map((field) => ({ name: field.name, type: field.type })),
    },
  });
}

function operationReference(
  context: RepositoryContext,
  operation: PrismaOperation,
): UnresolvedReference {
  const location = locationFor(operation.callableNode);
  return {
    name: operation.modelName,
    kind: operation.kind,
    sourceNodeId: operation.sourceNodeId,
    localName: null,
    importedName: null,
    provenance: "verified",
    confidence: 1,
    metadata: {
      framework: "prisma",
      model_accessor: operation.modelAccessor,
      operation: operation.operation,
      relationship: operation.kind === "prisma_query" ? "query" : "mutation",
    },
    evidence: {
      sourceType: "framework",
      file: context.relativeFilePath,
      line: location.line,
      column: location.column,
    },
  };
}

export const prismaAdapter: FrameworkAdapter = {
  name: "prisma",
  version: "prisma-framework-3",

  supports(relativeFilePath, language) {
    return path.posix.extname(relativeFilePath).toLowerCase() === ".prisma" ||
      ["typescript", "tsx", "javascript", "jsx"].includes(language ?? "");
  },

  detect(context) {
    return analyzeSchema(context).length > 0 || analyzeCode(context).operations.length > 0;
  },

  extractRoutes() {
    return [];
  },

  extractModels(context) {
    return analyzeSchema(context).map((model) => modelNode(context, model));
  },

  extractFrameworkRelationships(context, entities: FrameworkEntities): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const models = analyzeSchema(context);
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
        const targetName = field.type.replace(/[?[\]]/gu, "");
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

  extractFrameworkReferences(context) {
    return analyzeCode(context).operations.map((operation) =>
      operationReference(context, operation),
    );
  },

  suppressedReferences(context) {
    return analyzeCode(context).suppressedReferences;
  },
};
