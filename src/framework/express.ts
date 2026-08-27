import JavaScriptLanguage from "tree-sitter-javascript";
import TypeScriptLanguages from "tree-sitter-typescript";
import type { DetectedLanguage } from "../core/languages.js";
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
  "all",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);

interface ExpressRoute {
  syntaxNode: SyntaxNode;
  method: string;
  path: string | null;
  handler: string | null;
}

interface ExpressAnalysis {
  detected: boolean;
  routes: ExpressRoute[];
}

const analyses = new WeakMap<RepositoryContext, ExpressAnalysis>();

function grammarFor(language: DetectedLanguage | null): unknown {
  if (language === "typescript") return TypeScriptLanguages.typescript;
  if (language === "tsx") return TypeScriptLanguages.tsx;
  return JavaScriptLanguage;
}

function analyze(context: RepositoryContext): ExpressAnalysis {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const root = createTree(grammarFor(context.language), context.content).rootNode;
  const expressFactories = new Set<string>(["express"]);
  const routerFactories = new Set<string>(["Router"]);
  let detected = false;

  for (const statement of root.namedChildren) {
    if (statement.type !== "import_statement") continue;
    const source = stringLiteralValue(statement.childForFieldName("source"));
    if (source !== "express") continue;
    detected = true;
    const clause = statement.namedChildren.find((child) => child.type === "import_clause");
    for (const child of clause?.namedChildren ?? []) {
      if (child.type === "identifier") expressFactories.add(child.text);
      if (child.type !== "named_imports") continue;
      for (const specifier of child.namedChildren) {
        const imported = identifierText(specifier.childForFieldName("name"));
        const local = identifierText(specifier.childForFieldName("alias")) ?? imported;
        if (imported === "Router" && local !== null) routerFactories.add(local);
      }
    }
  }

  const applicationInstances = new Set<string>();
  const routerInstances = new Set<string>();
  walkSyntax(root, (node) => {
    if (node.type !== "variable_declarator") return;
    const variableName = identifierText(node.childForFieldName("name"));
    const value = node.childForFieldName("value");
    if (variableName === null || value?.type !== "call_expression") return;
    const callable = value.childForFieldName("function");
    const callableParts = memberParts(callable);
    if (callableParts?.join(".") === "require") {
      const required = stringLiteralValue(
        value.childForFieldName("arguments")?.namedChildren[0] ?? null,
      );
      if (required === "express") {
        detected = true;
        expressFactories.add(variableName);
      }
      return;
    }
    const callableName = callableParts?.join(".") ?? "";
    if (expressFactories.has(callableName)) applicationInstances.add(variableName);
    if (
      routerFactories.has(callableName) ||
      [...expressFactories].some((factory) => callableName === `${factory}.Router`)
    ) {
      routerInstances.add(variableName);
    }
  });

  const routeReceivers = new Set([...applicationInstances, ...routerInstances]);
  const routes: ExpressRoute[] = [];
  if (detected) {
    walkSyntax(root, (node) => {
      if (node.type !== "call_expression") return;
      const callable = node.childForFieldName("function");
      if (callable?.type !== "member_expression") return;
      const receiver = memberParts(callable.childForFieldName("object"))?.join(".");
      const method = identifierText(callable.childForFieldName("property"));
      if (receiver === undefined || method === null) return;
      if (!routeReceivers.has(receiver) || !HTTP_METHODS.has(method.toLowerCase())) return;
      const argumentsNode = node.childForFieldName("arguments");
      const routePath = argumentsNode?.namedChildren[0] ?? null;
      const handlerNode = argumentsNode?.namedChildren.at(-1) ?? null;
      routes.push({
        syntaxNode: node,
        method: method.toUpperCase(),
        path: stringLiteralValue(routePath),
        handler: identifierText(handlerNode),
      });
    });
  }

  const result = { detected, routes };
  analyses.set(context, result);
  return result;
}

function routeNode(context: RepositoryContext, route: ExpressRoute): GraphNode {
  const location = locationFor(route.syntaxNode);
  const pathHash = route.path === null ? null : literalHash("route", route.path);
  const qualifiedName = `express:${route.method}:${pathHash ?? "dynamic"}:${location.line}`;
  return frameworkNode(context, {
    kind: "api_route",
    name: `${route.method} ${route.handler ?? "anonymous"}`,
    qualifiedName,
    location,
    framework: "express",
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

export const expressAdapter: FrameworkAdapter = {
  name: "express",
  version: "express-framework-1",

  supports(_relativeFilePath, language) {
    return ["typescript", "tsx", "javascript", "jsx"].includes(language ?? "");
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
          metadata: { framework: "express" },
        }),
      );
      if (route.handler === null) continue;
      const handlerNodeId = symbolNodeId(context, route.handler, ["function", "method"]);
      if (handlerNodeId !== null) {
        edges.push(
          frameworkEdge(context, {
            edgeType: "HANDLES",
            sourceNodeId: node.id,
            targetNodeId: handlerNodeId,
            location,
            metadata: { framework: "express" },
          }),
        );
      }
    }
    return edges;
  },
};
