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
import type { FrameworkAdapter, FrameworkEntities, RepositoryContext } from "./types.js";

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);

interface FastifyRoute {
  syntaxNode: SyntaxNode;
  method: string;
  path: string | null;
  handler: string | null;
}

interface FastifyAnalysis {
  detected: boolean;
  routes: FastifyRoute[];
}

const analyses = new WeakMap<RepositoryContext, FastifyAnalysis>();

function grammarFor(language: DetectedLanguage | null): unknown {
  if (language === "typescript") return TypeScriptLanguages.typescript;
  if (language === "tsx") return TypeScriptLanguages.tsx;
  return JavaScriptLanguage;
}

function pairValue(object: SyntaxNode | null, names: ReadonlySet<string>): SyntaxNode | null {
  if (object?.type !== "object") return null;
  for (const pair of object.namedChildren) {
    if (pair.type !== "pair") continue;
    const keyNode = pair.childForFieldName("key");
    const key = identifierText(keyNode) ?? stringLiteralValue(keyNode);
    if (key !== null && names.has(key)) return pair.childForFieldName("value");
  }
  return null;
}

function handlerName(node: SyntaxNode | null): string | null {
  return identifierText(node) ?? memberParts(node)?.join(".") ?? null;
}

function analyze(context: RepositoryContext): FastifyAnalysis {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const root = createTree(grammarFor(context.language), context.content).rootNode;
  const receivers = new Set<string>(["fastify"]);
  const factories = new Set<string>(["Fastify", "fastify"]);
  let detected = false;

  for (const statement of root.namedChildren) {
    if (statement.type !== "import_statement") continue;
    const source = stringLiteralValue(statement.childForFieldName("source"));
    if (source !== "fastify" && source?.startsWith("@fastify/") !== true) continue;
    detected = true;
    const clause = statement.namedChildren.find((child) => child.type === "import_clause");
    for (const child of clause?.namedChildren ?? []) {
      if (child.type === "identifier") factories.add(child.text);
      if (child.type !== "named_imports") continue;
      for (const specifier of child.namedChildren) {
        const imported = identifierText(specifier.childForFieldName("name"));
        const local = identifierText(specifier.childForFieldName("alias")) ?? imported;
        if (imported === "fastify" || imported === "Fastify") {
          if (local !== null) factories.add(local);
        }
      }
    }
  }

  walkSyntax(root, (node) => {
    if (node.type !== "variable_declarator") return;
    const variable = identifierText(node.childForFieldName("name"));
    const value = node.childForFieldName("value");
    if (variable === null || value?.type !== "call_expression") return;
    const callable = memberParts(value.childForFieldName("function"))?.join(".");
    if (callable !== undefined && factories.has(callable)) {
      detected = true;
      receivers.add(variable);
    }
  });

  const routes: FastifyRoute[] = [];
  walkSyntax(root, (node) => {
    if (node.type !== "call_expression") return;
    const callable = node.childForFieldName("function");
    if (callable?.type !== "member_expression") return;
    const receiver = memberParts(callable.childForFieldName("object"))?.join(".");
    const method = identifierText(callable.childForFieldName("property"))?.toLowerCase();
    if (receiver === undefined || method === undefined) return;
    const receiverTail = receiver.split(".").at(-1) ?? receiver;
    const looksLikeFastify = receivers.has(receiver) || receiverTail === "fastify";
    if (!looksLikeFastify) return;
    const argumentsNode = node.childForFieldName("arguments");
    const args = argumentsNode?.namedChildren ?? [];

    if (HTTP_METHODS.has(method)) {
      detected = true;
      routes.push({
        syntaxNode: node,
        method: method.toUpperCase(),
        path: stringLiteralValue(args[0] ?? null),
        handler: handlerName(args.at(-1) ?? null),
      });
      return;
    }
    if (method !== "route") return;
    const options = args[0] ?? null;
    const methodNode = pairValue(options, new Set(["method"]));
    const pathNode = pairValue(options, new Set(["url", "path"]));
    const handlerNode = pairValue(options, new Set(["handler"]));
    const methods = methodNode?.type === "array"
      ? methodNode.namedChildren.map(stringLiteralValue).filter((value): value is string => value !== null)
      : [stringLiteralValue(methodNode)].filter((value): value is string => value !== null);
    if (methods.length === 0) return;
    detected = true;
    for (const routeMethod of methods) {
      routes.push({
        syntaxNode: node,
        method: routeMethod.toUpperCase(),
        path: stringLiteralValue(pathNode),
        handler: handlerName(handlerNode),
      });
    }
  });

  const result = { detected, routes };
  analyses.set(context, result);
  return result;
}

function routeNode(context: RepositoryContext, route: FastifyRoute): GraphNode {
  const location = locationFor(route.syntaxNode);
  const pathHash = route.path === null ? null : literalHash("route", route.path);
  return frameworkNode(context, {
    kind: "api_route",
    name: `${route.method} ${route.handler ?? "anonymous"}`,
    qualifiedName: `fastify:${route.method}:${pathHash ?? "dynamic"}:${location.line}`,
    location,
    framework: "fastify",
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

export const fastifyAdapter: FrameworkAdapter = {
  name: "fastify",
  version: "fastify-framework-1",

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
          metadata: { framework: "fastify" },
        }),
      );
      if (route.handler === null || route.handler.includes(".")) continue;
      const target = symbolNodeId(context, route.handler, ["function", "method"]);
      if (target !== null) {
        edges.push(
          frameworkEdge(context, {
            edgeType: "HANDLES",
            sourceNodeId: node.id,
            targetNodeId: target,
            location,
            metadata: { framework: "fastify" },
          }),
        );
      }
    }
    return edges;
  },
};
