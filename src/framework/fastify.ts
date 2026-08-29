import JavaScriptLanguage from "tree-sitter-javascript";
import TypeScriptLanguages from "tree-sitter-typescript";
import type { DetectedLanguage } from "../core/languages.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import type { UnresolvedReference } from "../parser/parser.js";
import { createTree, type SyntaxNode } from "../parser/tree-sitter.js";
import {
  containerNodeId,
  frameworkEdge,
  frameworkNode,
  literalHash,
  locationFor,
} from "./graph.js";
import { identifierText, memberParts, stringLiteralValue, walkSyntax } from "./syntax.js";
import type {
  FrameworkAdapter,
  FrameworkEntities,
  RepositoryContext,
  SuppressedFrameworkReference,
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
const REQUEST_HOOKS = new Set(["onRequest", "preValidation", "preHandler"]);

type ReceiverEvidence = {
  confidence: number;
  sourceType: "framework" | "heuristic";
  detection: string;
};

interface FastifyRoute {
  syntaxNode: SyntaxNode;
  callableNode: SyntaxNode;
  method: string;
  path: string | null;
  handler: string | null;
  handlerNode: SyntaxNode | null;
  hooks: string[];
  receiver: ReceiverEvidence;
}

interface FastifyDecorator {
  syntaxNode: SyntaxNode;
  callableNode: SyntaxNode;
  name: string;
  implementation: string | null;
}

interface FastifyRegistration {
  syntaxNode: SyntaxNode;
  callableNode: SyntaxNode;
  plugin: string | null;
  pluginNode: SyntaxNode | null;
  hooks: string[];
  prefix: string | null;
}

interface FastifyHookBinding {
  syntaxNode: SyntaxNode;
  callableNode: SyntaxNode;
  hook: string;
  implementation: string | null;
}

interface FastifyAnalysis {
  detected: boolean;
  routes: FastifyRoute[];
  decorators: FastifyDecorator[];
  registrations: FastifyRegistration[];
  hookBindings: FastifyHookBinding[];
  suppressedReferences: SuppressedFrameworkReference[];
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

function isInlineCallable(node: SyntaxNode | null): node is SyntaxNode {
  return node !== null && [
    "arrow_function",
    "function_expression",
    "generator_function",
  ].includes(node.type);
}

function parameterIdentifier(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  const direct = identifierText(node);
  if (direct !== null) return direct;
  for (const field of ["pattern", "name", "parameter"]) {
    const nested = parameterIdentifier(node.childForFieldName(field));
    if (nested !== null) return nested;
  }
  return null;
}

function firstParameter(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  const parameters = node.childForFieldName("parameters");
  if (parameters !== null) {
    for (const parameter of parameters.namedChildren) {
      const name = parameterIdentifier(parameter);
      if (name !== null) return name;
    }
  }
  return parameterIdentifier(node.childForFieldName("parameter"));
}

function functionName(node: SyntaxNode): string | null {
  const declared = identifierText(node.childForFieldName("name"));
  if (declared !== null) return declared;
  if (node.parent?.type === "variable_declarator") {
    return identifierText(node.parent.childForFieldName("name"));
  }
  return null;
}

function handlerNames(node: SyntaxNode | null): string[] {
  if (node?.type === "array") {
    return node.namedChildren
      .map(handlerName)
      .filter((value): value is string => value !== null);
  }
  const name = handlerName(node);
  return name === null ? [] : [name];
}

function requestHooks(options: SyntaxNode | null): string[] {
  return [...REQUEST_HOOKS].flatMap((name) =>
    handlerNames(pairValue(options, new Set([name]))),
  );
}

function suppressed(
  kind: UnresolvedReference["kind"],
  node: SyntaxNode | null,
): SuppressedFrameworkReference | null {
  if (node === null) return null;
  const location = locationFor(node);
  return { kind, line: location.line, column: location.column };
}

function analyze(context: RepositoryContext): FastifyAnalysis {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const root = createTree(grammarFor(context.language), context.content).rootNode;
  const receivers = new Map<string, ReceiverEvidence>([[
    "fastify",
    { confidence: 1, sourceType: "framework", detection: "conventional_receiver" },
  ]]);
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
        if ((imported === "fastify" || imported === "Fastify") && local !== null) {
          factories.add(local);
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
      receivers.set(variable, {
        confidence: 1,
        sourceType: "framework",
        detection: "fastify_factory_result",
      });
    }
  });

  const functionsByName = new Map<string, SyntaxNode>();
  walkSyntax(root, (node) => {
    if (![
      "function_declaration",
      "generator_function_declaration",
      "function_expression",
      "generator_function",
      "arrow_function",
    ].includes(node.type)) return;
    const name = functionName(node);
    if (name !== null) functionsByName.set(name, node);
    const parameter = firstParameter(node);
    if (parameter === null) return;
    const declarationText = node.parent?.type === "variable_declarator"
      ? node.parent.text
      : node.text.slice(0, Math.max(0, node.childForFieldName("body")?.startIndex ?? node.endIndex));
    if (/\bFastify(?:Instance|Plugin|PluginCallback|PluginAsync)\b/u.test(declarationText)) {
      receivers.set(parameter, {
        confidence: 1,
        sourceType: "framework",
        detection: "fastify_type_annotation",
      });
    } else if (detected && /(?:^|[_$])(routes?|plugin)(?:[_$]|$)/iu.test(name ?? "")) {
      receivers.set(parameter, {
        confidence: 0.8,
        sourceType: "heuristic",
        detection: "fastify_plugin_naming_convention",
      });
    }
  });

  // Registration callbacks inherit the Fastify instance through their first
  // parameter. Iterate because nested inline registrations form a small fixed point.
  for (let pass = 0; pass < 8; pass += 1) {
    let added = false;
    walkSyntax(root, (node) => {
      if (node.type !== "call_expression") return;
      const callable = node.childForFieldName("function");
      if (callable?.type !== "member_expression") return;
      const receiver = memberParts(callable.childForFieldName("object"))?.join(".");
      const method = identifierText(callable.childForFieldName("property"))?.toLowerCase();
      if (receiver === undefined || method !== "register" || !receivers.has(receiver)) return;
      const pluginExpression = node.childForFieldName("arguments")?.namedChildren[0] ?? null;
      const pluginFunction = isInlineCallable(pluginExpression)
        ? pluginExpression
        : functionsByName.get(handlerName(pluginExpression) ?? "") ?? null;
      const parameter = firstParameter(pluginFunction);
      if (parameter === null || receivers.has(parameter)) return;
      receivers.set(parameter, {
        confidence: 1,
        sourceType: "framework",
        detection: "registered_plugin_parameter",
      });
      added = true;
    });
    if (!added) break;
  }

  const routes: FastifyRoute[] = [];
  const decorators: FastifyDecorator[] = [];
  const registrations: FastifyRegistration[] = [];
  const hookBindings: FastifyHookBinding[] = [];
  const suppressedReferences: SuppressedFrameworkReference[] = [];
  walkSyntax(root, (node) => {
    if (node.type !== "call_expression") return;
    const callable = node.childForFieldName("function");
    if (callable?.type !== "member_expression") return;
    const receiver = memberParts(callable.childForFieldName("object"))?.join(".");
    const method = identifierText(callable.childForFieldName("property"))?.toLowerCase();
    if (receiver === undefined || method === undefined) return;
    const receiverTail = receiver.split(".").at(-1) ?? receiver;
    const receiverEvidence = receivers.get(receiver) ?? (
      receiverTail === "fastify"
        ? { confidence: 1, sourceType: "framework" as const, detection: "fastify_receiver_tail" }
        : null
    );
    if (receiverEvidence === null) return;
    const args = node.childForFieldName("arguments")?.namedChildren ?? [];

    if (
      !HTTP_METHODS.has(method) &&
      method !== "route" &&
      method !== "decorate" &&
      method !== "register" &&
      method !== "addhook"
    ) {
      return;
    }
    const genericCall = suppressed("call", callable);
    if (genericCall !== null) suppressedReferences.push(genericCall);

    if (HTTP_METHODS.has(method)) {
      detected = true;
      const options = args.length >= 3 ? args.at(-2) ?? null : null;
      routes.push({
        syntaxNode: node,
        callableNode: callable,
        method: method.toUpperCase(),
        path: stringLiteralValue(args[0] ?? null),
        handler: handlerName(args.at(-1) ?? null),
        handlerNode: isInlineCallable(args.at(-1) ?? null) ? args.at(-1)! : null,
        hooks: requestHooks(options),
        receiver: receiverEvidence,
      });
      return;
    }

    if (method === "route") {
      const options = args[0] ?? null;
      const methodNode = pairValue(options, new Set(["method"]));
      const pathNode = pairValue(options, new Set(["url", "path"]));
      const handlerNode = pairValue(options, new Set(["handler"]));
      const methods = methodNode?.type === "array"
        ? methodNode.namedChildren
            .map(stringLiteralValue)
            .filter((value): value is string => value !== null)
        : [stringLiteralValue(methodNode)].filter((value): value is string => value !== null);
      if (methods.length === 0) return;
      detected = true;
      for (const routeMethod of methods) {
        routes.push({
          syntaxNode: node,
          callableNode: callable,
          method: routeMethod.toUpperCase(),
          path: stringLiteralValue(pathNode),
          handler: handlerName(handlerNode),
          handlerNode: isInlineCallable(handlerNode) ? handlerNode : null,
          hooks: requestHooks(options),
          receiver: receiverEvidence,
        });
      }
      return;
    }

    if (method === "decorate") {
      const name = stringLiteralValue(args[0] ?? null);
      if (name === null) return;
      detected = true;
      decorators.push({
        syntaxNode: node,
        callableNode: callable,
        name,
        implementation: handlerName(args[1] ?? null),
      });
      return;
    }

    if (method === "register") {
      detected = true;
      const options = args[1] ?? null;
      registrations.push({
        syntaxNode: node,
        callableNode: callable,
        plugin: handlerName(args[0] ?? null),
        pluginNode: isInlineCallable(args[0] ?? null) ? args[0]! : null,
        hooks: requestHooks(options),
        prefix: stringLiteralValue(pairValue(options, new Set(["prefix"]))),
      });
      const runtimeRegistration = suppressed("runtime_registration", args.at(-1) ?? null);
      if (runtimeRegistration !== null && handlerName(args.at(-1) ?? null) !== null) {
        suppressedReferences.push(runtimeRegistration);
      }
      return;
    }

    const hook = stringLiteralValue(args[0] ?? null);
    if (hook === null || !REQUEST_HOOKS.has(hook)) return;
    detected = true;
    hookBindings.push({
      syntaxNode: node,
      callableNode: callable,
      hook,
      implementation: handlerName(args[1] ?? null),
    });
  });

  const result = {
    detected,
    routes,
    decorators,
    registrations,
    hookBindings,
    suppressedReferences,
  };
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
    sourceType: route.receiver.sourceType,
    confidence: Math.min(route.path === null ? 0.85 : 1, route.receiver.confidence),
    signature: `${route.method} ${route.path === null ? "<dynamic>" : "<literal>"}`,
    metadata: {
      http_method: route.method,
      route_path_hash: pathHash,
      path_kind: route.path === null ? "dynamic" : "static_literal",
      handler: route.handler,
      hook_count: route.hooks.length,
      receiver_detection: route.receiver.detection,
    },
  });
}

function inlineRouteHandlerNode(context: RepositoryContext, route: FastifyRoute): GraphNode | null {
  if (route.handlerNode === null) return null;
  const location = locationFor(route.handlerNode);
  const routeLocation = locationFor(route.syntaxNode);
  return frameworkNode(context, {
    kind: "function",
    name: `${route.method} inline handler`,
    qualifiedName: `fastify:inline-handler:${routeLocation.line}:${routeLocation.column}`,
    location,
    framework: "fastify",
    sourceType: route.receiver.sourceType,
    confidence: route.receiver.confidence,
    signature: `${route.method} inline route handler`,
    metadata: {
      fastify_entity: "inline_route_handler",
      route_line: routeLocation.line,
      route_column: routeLocation.column,
      receiver_detection: route.receiver.detection,
    },
  });
}

function inlinePluginNode(
  context: RepositoryContext,
  registration: FastifyRegistration,
): GraphNode | null {
  if (registration.pluginNode === null) return null;
  const location = locationFor(registration.pluginNode);
  const registrationLocation = locationFor(registration.syntaxNode);
  return frameworkNode(context, {
    kind: "function",
    name: `inline Fastify plugin at line ${registrationLocation.line}`,
    qualifiedName: `fastify:inline-plugin:${registrationLocation.line}:${registrationLocation.column}`,
    location,
    framework: "fastify",
    signature: "inline Fastify plugin",
    metadata: {
      fastify_entity: "inline_plugin",
      registration_line: registrationLocation.line,
      registration_column: registrationLocation.column,
    },
  });
}

function decoratorNode(context: RepositoryContext, decorator: FastifyDecorator): GraphNode {
  return frameworkNode(context, {
    kind: "configuration",
    name: decorator.name,
    qualifiedName: `fastify.${decorator.name}`,
    location: locationFor(decorator.syntaxNode),
    framework: "fastify",
    signature: `fastify.decorate(<literal>, ${decorator.implementation ?? "<dynamic>"})`,
    metadata: {
      fastify_entity: "decorator",
      decorator_name_hash: literalHash("fastify_decorator", decorator.name),
      implementation: decorator.implementation,
    },
  });
}

function registrationNode(
  context: RepositoryContext,
  registration: FastifyRegistration,
): GraphNode {
  const location = locationFor(registration.syntaxNode);
  return frameworkNode(context, {
    kind: "configuration",
    name: `register ${registration.plugin ?? "dynamic plugin"}`,
    qualifiedName: `fastify:registration:${registration.plugin ?? "dynamic"}:${location.line}`,
    location,
    framework: "fastify",
    confidence: registration.plugin === null ? 0.8 : 1,
    signature: `fastify.register(${registration.plugin ?? "<dynamic>"})`,
    metadata: {
      fastify_entity: "registration",
      plugin: registration.plugin,
      inline_plugin: registration.pluginNode !== null,
      hook_count: registration.hooks.length,
      prefix_hash:
        registration.prefix === null
          ? null
          : literalHash("fastify_route_prefix", registration.prefix),
      prefix_kind: registration.prefix === null ? "none" : "static_literal",
    },
  });
}

function hookBindingNode(context: RepositoryContext, binding: FastifyHookBinding): GraphNode {
  const location = locationFor(binding.syntaxNode);
  return frameworkNode(context, {
    kind: "configuration",
    name: `${binding.hook} hook`,
    qualifiedName: `fastify:hook:${binding.hook}:${location.line}`,
    location,
    framework: "fastify",
    signature: `fastify.addHook(<literal>, ${binding.implementation ?? "<dynamic>"})`,
    metadata: {
      fastify_entity: "hook_binding",
      hook: binding.hook,
      implementation: binding.implementation,
    },
  });
}

function supportingNode(
  entities: FrameworkEntities,
  entity: string,
  line: number,
): GraphNode | null {
  return entities.supporting.find(
    (node) => node.metadata.fastify_entity === entity && node.startLine === line,
  ) ?? null;
}

function inlineEntityNode(
  entities: FrameworkEntities,
  entity: "inline_route_handler" | "inline_plugin",
  ownerLineKey: "route_line" | "registration_line",
  syntaxNode: SyntaxNode,
): GraphNode | null {
  const location = locationFor(syntaxNode);
  return entities.supporting.find(
    (node) =>
      node.metadata.fastify_entity === entity &&
      node.metadata[ownerLineKey] === location.line,
  ) ?? null;
}

function containingInlinePluginNodeId(
  context: RepositoryContext,
  entities: FrameworkEntities,
  syntaxNode: SyntaxNode,
  excludedNodeId?: string,
): string {
  const line = syntaxNode.startPosition.row + 1;
  const candidates = entities.supporting.filter(
    (node) =>
      node.metadata.fastify_entity === "inline_plugin" &&
      node.id !== excludedNodeId &&
      node.startLine !== null &&
      node.endLine !== null &&
      node.startLine <= line &&
      node.endLine >= line,
  );
  candidates.sort(
    (left, right) =>
      (left.endLine! - left.startLine!) - (right.endLine! - right.startLine!),
  );
  return candidates[0]?.id ?? enclosingCallableNodeId(context, syntaxNode);
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

function frameworkReference(
  context: RepositoryContext,
  input: {
    name: string;
    kind: UnresolvedReference["kind"];
    sourceNodeId: string;
    syntaxNode: SyntaxNode;
    metadata?: Record<string, unknown>;
  },
): UnresolvedReference {
  const location = locationFor(input.syntaxNode);
  return {
    name: input.name,
    kind: input.kind,
    sourceNodeId: input.sourceNodeId,
    localName: null,
    importedName: null,
    provenance: "verified",
    confidence: 1,
    metadata: { framework: "fastify", ...(input.metadata ?? {}) },
    evidence: {
      sourceType: "framework",
      file: context.relativeFilePath,
      line: location.line,
      column: location.column,
    },
  };
}

function hookTarget(expression: string): string {
  return expression.split(".").at(-1) ?? expression;
}

export const fastifyAdapter: FrameworkAdapter = {
  name: "fastify",
  version: "fastify-framework-3",

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

  extractSupportingNodes(context) {
    const analysis = analyze(context);
    return [
      ...analysis.decorators.map((decorator) => decoratorNode(context, decorator)),
      ...analysis.registrations.map((registration) => registrationNode(context, registration)),
      ...analysis.hookBindings.map((binding) => hookBindingNode(context, binding)),
      ...analysis.routes.flatMap((route) => {
        const node = inlineRouteHandlerNode(context, route);
        return node === null ? [] : [node];
      }),
      ...analysis.registrations.flatMap((registration) => {
        const node = inlinePluginNode(context, registration);
        return node === null ? [] : [node];
      }),
    ];
  },

  extractFrameworkRelationships(context, entities: FrameworkEntities): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const analysis = analyze(context);
    for (const [index, node] of entities.routes.entries()) {
      const route = analysis.routes[index];
      if (route === undefined) continue;
      edges.push(
        frameworkEdge(context, {
          edgeType: "EXPOSES",
          sourceNodeId: containingInlinePluginNodeId(context, entities, route.syntaxNode),
          targetNodeId: node.id,
          location: locationFor(route.syntaxNode),
          sourceType: route.receiver.sourceType,
          confidence: route.receiver.confidence,
          metadata: {
            framework: "fastify",
            receiver_detection: route.receiver.detection,
          },
        }),
      );
      const inlineHandler = inlineEntityNode(
        entities,
        "inline_route_handler",
        "route_line",
        route.syntaxNode,
      );
      if (inlineHandler !== null) {
        edges.push(
          frameworkEdge(context, {
            edgeType: "HANDLES",
            sourceNodeId: node.id,
            targetNodeId: inlineHandler.id,
            location: locationFor(route.handlerNode ?? route.syntaxNode),
            sourceType: route.receiver.sourceType,
            confidence: route.receiver.confidence,
            metadata: {
              framework: "fastify",
              relationship: "inline_route_handler",
              receiver_detection: route.receiver.detection,
            },
          }),
        );
      }
    }
    const supportingEntities: Array<{
      type: string;
      relationship: string;
      syntaxNode: SyntaxNode;
    }> = [
      ...analysis.decorators.map((entry) => ({
        type: "decorator",
        relationship: "decorate",
        syntaxNode: entry.syntaxNode,
      })),
      ...analysis.registrations.map((entry) => ({
        type: "registration",
        relationship: "register",
        syntaxNode: entry.syntaxNode,
      })),
      ...analysis.hookBindings.map((entry) => ({
        type: "hook_binding",
        relationship: "add_hook",
        syntaxNode: entry.syntaxNode,
      })),
    ];
    for (const entry of supportingEntities) {
      const node = supportingNode(
        entities,
        entry.type,
        entry.syntaxNode.startPosition.row + 1,
      );
      if (node === null) continue;
      const configuredInlinePlugin = entry.type === "registration"
        ? inlineEntityNode(
            entities,
            "inline_plugin",
            "registration_line",
            entry.syntaxNode,
          )
        : null;
      edges.push(
        frameworkEdge(context, {
          edgeType: "CONFIGURES",
          sourceNodeId: containingInlinePluginNodeId(
            context,
            entities,
            entry.syntaxNode,
            configuredInlinePlugin?.id,
          ),
          targetNodeId: node.id,
          location: locationFor(entry.syntaxNode),
          metadata: { framework: "fastify", relationship: entry.relationship },
        }),
      );
    }
    for (const registration of analysis.registrations) {
      if (registration.pluginNode === null) continue;
      const registrationEntity = supportingNode(
        entities,
        "registration",
        registration.syntaxNode.startPosition.row + 1,
      );
      const pluginEntity = inlineEntityNode(
        entities,
        "inline_plugin",
        "registration_line",
        registration.syntaxNode,
      );
      if (registrationEntity === null || pluginEntity === null) continue;
      edges.push(
        frameworkEdge(context, {
          edgeType: "MOUNTS",
          sourceNodeId: registrationEntity.id,
          targetNodeId: pluginEntity.id,
          location: locationFor(registration.pluginNode),
          metadata: { framework: "fastify", relationship: "inline_plugin_registration" },
        }),
      );
    }
    return edges;
  },

  extractFrameworkReferences(context, entities) {
    const references: UnresolvedReference[] = [];
    const analysis = analyze(context);
    for (const [index, route] of analysis.routes.entries()) {
      const routeGraphNode = entities.routes[index];
      if (routeGraphNode === undefined) continue;
      if (route.handler !== null) {
        references.push(
          frameworkReference(context, {
            name: route.handler,
            kind: "framework_route_handler",
            sourceNodeId: routeGraphNode.id,
            syntaxNode: route.callableNode,
            metadata: { relationship: "route_handler" },
          }),
        );
      }
      for (const hook of route.hooks) {
        references.push(
          frameworkReference(context, {
            name: hookTarget(hook),
            kind: "framework_protection",
            sourceNodeId: routeGraphNode.id,
            syntaxNode: route.callableNode,
            metadata: { hook_expression: hook, relationship: "route_hook" },
          }),
        );
      }
    }
    for (const decorator of analysis.decorators) {
      const node = supportingNode(
        entities,
        "decorator",
        decorator.syntaxNode.startPosition.row + 1,
      );
      if (node !== null && decorator.implementation !== null) {
        references.push(
          frameworkReference(context, {
            name: decorator.implementation,
            kind: "framework_implementation",
            sourceNodeId: node.id,
            syntaxNode: decorator.callableNode,
            metadata: { relationship: "decorator_implementation" },
          }),
        );
      }
    }
    for (const registration of analysis.registrations) {
      const node = supportingNode(
        entities,
        "registration",
        registration.syntaxNode.startPosition.row + 1,
      );
      if (node === null) continue;
      if (registration.plugin !== null) {
        references.push(
          frameworkReference(context, {
            name: registration.plugin,
            kind: "framework_mount",
            sourceNodeId: node.id,
            syntaxNode: registration.callableNode,
            metadata: { relationship: "plugin_registration" },
          }),
        );
      }
      for (const hook of registration.hooks) {
        references.push(
          frameworkReference(context, {
            name: hookTarget(hook),
            kind: "framework_hook",
            sourceNodeId: node.id,
            syntaxNode: registration.callableNode,
            metadata: { hook_expression: hook, relationship: "plugin_hook" },
          }),
        );
      }
    }
    for (const binding of analysis.hookBindings) {
      const node = supportingNode(
        entities,
        "hook_binding",
        binding.syntaxNode.startPosition.row + 1,
      );
      if (node !== null && binding.implementation !== null) {
        references.push(
          frameworkReference(context, {
            name: hookTarget(binding.implementation),
            kind: "framework_hook",
            sourceNodeId: node.id,
            syntaxNode: binding.callableNode,
            metadata: { relationship: "add_hook" },
          }),
        );
      }
    }
    return references;
  },

  suppressedReferences(context) {
    return analyze(context).suppressedReferences;
  },
};
