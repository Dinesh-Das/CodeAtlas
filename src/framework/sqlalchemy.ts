import PythonLanguage from "tree-sitter-python";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { createTree, type SyntaxNode } from "../parser/tree-sitter.js";
import {
  containerNodeId,
  frameworkEdge,
  frameworkNode,
  literalHash,
  locationFor,
  symbolNodeId,
} from "./graph.js";
import { identifierText, memberParts, stringLiteralValue, walkSyntax } from "./syntax.js";
import type {
  FrameworkAdapter,
  FrameworkEntities,
  RepositoryContext,
} from "./types.js";

interface SqlAlchemyField {
  name: string;
  mapper: string;
  line: number;
  column: number;
  relationshipTarget: string | null;
}

interface SqlAlchemyModel {
  name: string;
  syntaxNode: SyntaxNode;
  tableName: string | null;
  fields: SqlAlchemyField[];
}

interface SqlAlchemyAnalysis {
  detected: boolean;
  models: SqlAlchemyModel[];
}

const analyses = new WeakMap<RepositoryContext, SqlAlchemyAnalysis>();
const FIELD_MAPPERS = new Set(["Column", "mapped_column", "relationship"]);

function assignmentsInClass(node: SyntaxNode): SyntaxNode[] {
  const body = node.childForFieldName("body");
  if (body === null) return [];
  return body.namedChildren.flatMap((statement) => {
    if (statement.type === "expression_statement") {
      return statement.namedChildren.filter((child) => child.type === "assignment");
    }
    return statement.type === "assignment" ? [statement] : [];
  });
}

function assignmentCall(node: SyntaxNode): SyntaxNode | null {
  const right = node.childForFieldName("right");
  return right?.type === "call" ? right : null;
}

function analyze(context: RepositoryContext): SqlAlchemyAnalysis {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const root = createTree(PythonLanguage, context.content).rootNode;
  let detected = false;
  for (const statement of root.namedChildren) {
    if (statement.type !== "import_from_statement" && statement.type !== "import_statement") {
      continue;
    }
    const moduleName =
      statement.childForFieldName("module_name")?.text ??
      statement.childrenForFieldName("name")[0]?.text;
    if (moduleName === "sqlalchemy" || moduleName?.startsWith("sqlalchemy.") === true) {
      detected = true;
    }
  }

  const declarativeBases = new Set<string>();
  walkSyntax(root, (node) => {
    if (node.type === "assignment") {
      const name = identifierText(node.childForFieldName("left"));
      const call = assignmentCall(node);
      const factory = memberParts(call?.childForFieldName("function") ?? null)?.at(-1);
      if (name !== null && factory === "declarative_base") declarativeBases.add(name);
    }
    if (node.type === "class_definition") {
      const name = identifierText(node.childForFieldName("name"));
      const superclasses = node.childForFieldName("superclasses");
      const bases = superclasses?.namedChildren
        .map((base) => memberParts(base)?.at(-1))
        .filter((base): base is string => base !== undefined) ?? [];
      if (name !== null && bases.includes("DeclarativeBase")) declarativeBases.add(name);
    }
  });

  const models: SqlAlchemyModel[] = [];
  if (detected) {
    for (const node of root.namedChildren.filter(
      (candidate) => candidate.type === "class_definition",
    )) {
      const name = identifierText(node.childForFieldName("name"));
      if (name === null) continue;
      const bases =
        node
          .childForFieldName("superclasses")
          ?.namedChildren.map((base) => memberParts(base)?.at(-1))
          .filter((base): base is string => base !== undefined) ?? [];
      let tableName: string | null = null;
      const fields: SqlAlchemyField[] = [];
      for (const assignment of assignmentsInClass(node)) {
        const fieldName = identifierText(assignment.childForFieldName("left"));
        const right = assignment.childForFieldName("right");
        if (fieldName === "__tablename__") {
          tableName = stringLiteralValue(right);
          continue;
        }
        const call = assignmentCall(assignment);
        const mapper = memberParts(call?.childForFieldName("function") ?? null)?.at(-1);
        if (fieldName === null || mapper === undefined || !FIELD_MAPPERS.has(mapper)) continue;
        const location = locationFor(assignment);
        fields.push({
          name: fieldName,
          mapper,
          line: location.line,
          column: location.column,
          relationshipTarget:
            mapper === "relationship"
              ? stringLiteralValue(call?.childForFieldName("arguments")?.namedChildren[0] ?? null)
              : null,
        });
      }
      const isMapped =
        bases.some((base) => declarativeBases.has(base)) ||
        tableName !== null ||
        fields.length > 0;
      const declaresBase = bases.includes("DeclarativeBase") && tableName === null && fields.length === 0;
      if (isMapped && !declaresBase) models.push({ name, syntaxNode: node, tableName, fields });
    }
  }

  const result = { detected, models };
  analyses.set(context, result);
  return result;
}

function modelNode(context: RepositoryContext, model: SqlAlchemyModel): GraphNode {
  return frameworkNode(context, {
    kind: "database_model",
    name: model.name,
    qualifiedName: model.name,
    location: locationFor(model.syntaxNode),
    framework: "sqlalchemy",
    signature: `class ${model.name}`,
    metadata: {
      table_name_hash:
        model.tableName === null ? null : literalHash("database-table", model.tableName),
      field_count: model.fields.length,
      fields: model.fields.map((field) => ({ name: field.name, mapper: field.mapper })),
    },
  });
}

export const sqlAlchemyAdapter: FrameworkAdapter = {
  name: "sqlalchemy",
  version: "sqlalchemy-framework-1",

  supports(_relativeFilePath, language) {
    return language === "python";
  },

  detect(context) {
    return analyze(context).detected;
  },

  extractRoutes() {
    return [];
  },

  extractModels(context) {
    return analyze(context).models.map((model) => modelNode(context, model));
  },

  extractFrameworkRelationships(context, entities: FrameworkEntities): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const models = analyze(context).models;
    const nodesByName = new Map(entities.models.map((node) => [node.name, node]));
    for (const [index, node] of entities.models.entries()) {
      const model = models[index];
      if (model === undefined) continue;
      const location = locationFor(model.syntaxNode);
      edges.push(
        frameworkEdge(context, {
          edgeType: "CONTAINS",
          sourceNodeId: containerNodeId(context),
          targetNodeId: node.id,
          location,
          metadata: { framework: "sqlalchemy" },
        }),
      );
      const classNodeId = symbolNodeId(context, model.name, ["class"]);
      if (classNodeId !== null) {
        edges.push(
          frameworkEdge(context, {
            edgeType: "REFERENCES",
            sourceNodeId: node.id,
            targetNodeId: classNodeId,
            location,
            metadata: { framework: "sqlalchemy", semantic_role: "mapped_class" },
          }),
        );
      }
      for (const field of model.fields) {
        if (field.relationshipTarget === null) continue;
        const target = nodesByName.get(field.relationshipTarget);
        if (target === undefined) continue;
        edges.push(
          frameworkEdge(context, {
            edgeType: "REFERENCES",
            sourceNodeId: node.id,
            targetNodeId: target.id,
            location: { line: field.line, column: field.column },
            metadata: { framework: "sqlalchemy", field: field.name },
          }),
        );
      }
    }
    return edges;
  },
};
