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

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);

interface FastApiRoute {
  syntaxNode: SyntaxNode;
  method: string;
  path: string | null;
  handler: string;
}

interface FastApiAnalysis {
  detected: boolean;
  routes: FastApiRoute[];
}

const analyses = new WeakMap<RepositoryContext, FastApiAnalysis>();

function analyze(context: RepositoryContext): FastApiAnalysis {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const root = createTree(PythonLanguage, context.content).rootNode;
  let detected = false;
  const instances = new Set<string>();

  for (const statement of root.namedChildren) {
    if (statement.type !== "import_from_statement") continue;
    const moduleName = statement.childForFieldName("module_name")?.text;
    if (moduleName === "fastapi" || moduleName?.startsWith("fastapi.") === true) {
      detected = true;
    }
  }

  walkSyntax(root, (node) => {
    if (node.type !== "assignment") return;
    const variableName = identifierText(node.childForFieldName("left"));
    const value = node.childForFieldName("right");
    if (variableName === null || value?.type !== "call") return;
    const constructor = memberParts(value.childForFieldName("function"))?.at(-1);
    if (constructor === "FastAPI" || constructor === "APIRouter") {
      instances.add(variableName);
    }
  });

  const routes: FastApiRoute[] = [];
  if (detected) {
    for (const decorated of root.namedChildren.filter(
      (node) => node.type === "decorated_definition",
    )) {
      const definition = decorated.childForFieldName("definition");
      const handler = identifierText(definition?.childForFieldName("name") ?? null);
      if (handler === null) continue;
      for (const decorator of decorated.namedChildren.filter(
        (node) => node.type === "decorator",
      )) {
        const call = decorator.namedChildren.find((node) => node.type === "call");
        const callable = call?.childForFieldName("function") ?? null;
        const parts = memberParts(callable);
        const receiver = parts?.slice(0, -1).join(".");
        const method = parts?.at(-1)?.toLowerCase();
        if (
          call === undefined ||
          receiver === undefined ||
          method === undefined ||
          !instances.has(receiver) ||
          !HTTP_METHODS.has(method)
        ) {
          continue;
        }
        routes.push({
          syntaxNode: decorator,
          method: method.toUpperCase(),
          path: stringLiteralValue(
            call.childForFieldName("arguments")?.namedChildren[0] ?? null,
          ),
          handler,
        });
      }
    }
  }

  const result = { detected, routes };
  analyses.set(context, result);
  return result;
}

function routeNode(context: RepositoryContext, route: FastApiRoute): GraphNode {
  const location = locationFor(route.syntaxNode);
  const pathHash = route.path === null ? null : literalHash("route", route.path);
  return frameworkNode(context, {
    kind: "api_route",
    name: `${route.method} ${route.handler}`,
    qualifiedName: `fastapi:${route.method}:${pathHash ?? "dynamic"}:${location.line}`,
    location,
    framework: "fastapi",
    confidence: route.path === null ? 0.85 : 1,
    signature: `${route.method} ${route.path === null ? "<dynamic>" : "<literal>"}`,
    metadata: {
      http_method: route.method,
      route_path_hash: pathHash,
      path_kind: route.path === null ? "dynamic" : "static_literal",
      handler: route.handler,
    },
  });
}

export const fastApiAdapter: FrameworkAdapter = {
  name: "fastapi",
  version: "fastapi-framework-1",

  supports(_relativeFilePath, language) {
    return language === "python";
  },

  detect(context) {
    return analyze(context).detected;
  },

  extractRoutes(context) {
    return analyze(context).routes.map((route) => routeNode(context, route));
  },

  extractModels() {
    return [];
  },

  extractFrameworkRelationships(context, entities: FrameworkEntities): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const routes = analyze(context).routes;
    for (const [index, node] of entities.routes.entries()) {
      const route = routes[index];
      if (route === undefined) continue;
      const location = locationFor(route.syntaxNode);
      edges.push(
        frameworkEdge(context, {
          edgeType: "EXPOSES",
          sourceNodeId: containerNodeId(context),
          targetNodeId: node.id,
          location,
          metadata: { framework: "fastapi" },
        }),
      );
      const handlerNodeId = symbolNodeId(context, route.handler, ["function", "method"]);
      if (handlerNodeId !== null) {
        edges.push(
          frameworkEdge(context, {
            edgeType: "HANDLES",
            sourceNodeId: node.id,
            targetNodeId: handlerNodeId,
            location,
            metadata: { framework: "fastapi" },
          }),
        );
      }
    }
    return edges;
  },
};
