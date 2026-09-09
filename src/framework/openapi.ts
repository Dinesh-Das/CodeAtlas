import path from "node:path";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { containerNodeId, frameworkEdge, frameworkNode, literalHash } from "./graph.js";
import type { FrameworkAdapter, FrameworkEntities, RepositoryContext } from "./types.js";

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

interface Operation {
  method: string;
  routePath: string;
  operationId: string | null;
  line: number;
  requestSchemas: string[];
  responseSchemas: string[];
  security: string[];
  securityDeclared: boolean;
}

interface OpenApiAnalysis {
  title: string;
  operations: Operation[];
  schemas: string[];
  servers: string[];
  securitySchemes: string[];
  defaultSecurity: string[];
}

const analyses = new WeakMap<RepositoryContext, OpenApiAnalysis | null>();

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function schemaReferences(value: unknown, found = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) schemaReferences(item, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref" && typeof child === "string") found.add(child.split("/").at(-1) ?? child);
      else schemaReferences(child, found);
    }
  }
  return [...found].sort((left, right) => left.localeCompare(right));
}

function lineOf(content: string, value: string): number {
  const index = content.indexOf(value);
  return index < 0 ? 1 : content.slice(0, index).split(/\r?\n/u).length;
}

function parseJson(context: RepositoryContext): OpenApiAnalysis | null {
  let document: Record<string, unknown>;
  try {
    document = record(JSON.parse(context.content) as unknown);
  } catch {
    return null;
  }
  if (typeof document.openapi !== "string" && typeof document.swagger !== "string") return null;
  const info = record(document.info);
  const operations: Operation[] = [];
  for (const [routePath, rawPath] of Object.entries(record(document.paths))) {
    for (const [method, rawOperation] of Object.entries(record(rawPath))) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const operation = record(rawOperation);
      operations.push({
        method: method.toUpperCase(),
        routePath,
        operationId: typeof operation.operationId === "string" ? operation.operationId : null,
        line: lineOf(context.content, `"${routePath}"`),
        requestSchemas: schemaReferences(operation.requestBody),
        responseSchemas: schemaReferences(operation.responses),
        securityDeclared: Object.hasOwn(operation, "security"),
        security: (Array.isArray(operation.security) ? operation.security : [])
          .flatMap((entry) => Object.keys(record(entry))),
      });
    }
  }
  const components = record(document.components);
  return {
    title: typeof info.title === "string" ? info.title : path.posix.basename(context.relativeFilePath),
    operations,
    schemas: Object.keys(record(components.schemas)).sort((left, right) => left.localeCompare(right)),
    servers: (Array.isArray(document.servers) ? document.servers : [])
      .flatMap((server) => typeof record(server).url === "string" ? [String(record(server).url)] : []),
    securitySchemes: Object.keys(record(components.securitySchemes)).sort((left, right) => left.localeCompare(right)),
    defaultSecurity: (Array.isArray(document.security) ? document.security : [])
      .flatMap((entry) => Object.keys(record(entry))),
  };
}

function parseYaml(context: RepositoryContext): OpenApiAnalysis | null {
  if (!/^\s*(?:openapi|swagger):/mu.test(context.content)) return null;
  const lines = context.content.split(/\r?\n/u);
  const operations: Operation[] = [];
  let inPaths = false;
  let routePath: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (/^paths:\s*$/u.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^\S/u.test(line)) {
      inPaths = false;
      routePath = null;
    }
    if (!inPaths) continue;
    const route = /^\s{2}(['"]?)(\/[^:'"]+)\1:\s*$/u.exec(line);
    if (route !== null) {
      routePath = route[2]!;
      continue;
    }
    const method = /^\s{4}(get|put|post|delete|options|head|patch|trace):\s*$/iu.exec(line);
    if (method !== null && routePath !== null) {
      operations.push({
        method: method[1]!.toUpperCase(), routePath, operationId: null, line: index + 1,
        requestSchemas: [], responseSchemas: [], security: [],
        securityDeclared: false,
      });
    }
  }
  const title = /^\s*title:\s*['"]?([^'"\r\n]+)['"]?\s*$/mu.exec(context.content)?.[1]?.trim() ??
    path.posix.basename(context.relativeFilePath);
  return { title, operations, schemas: [], servers: [], securitySchemes: [], defaultSecurity: [] };
}

function analyze(context: RepositoryContext): OpenApiAnalysis | null {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const value = path.posix.extname(context.relativeFilePath).toLowerCase() === ".json"
    ? parseJson(context)
    : parseYaml(context);
  analyses.set(context, value);
  return value;
}

function node(context: RepositoryContext, kind: GraphNode["kind"], name: string, qualifiedName: string, line: number, metadata: Record<string, unknown>): GraphNode {
  return frameworkNode(context, {
    kind, name, qualifiedName,
    location: { line, column: 0, endLine: line, endColumn: 1 },
    framework: "openapi", sourceType: "config", metadata,
  });
}

export const openApiAdapter: FrameworkAdapter = {
  name: "openapi",
  version: "openapi-contract-1",

  supports(relativeFilePath) {
    const base = path.posix.basename(relativeFilePath).toLowerCase();
    return /(?:openapi|swagger)/u.test(base) && /\.(?:json|ya?ml)$/u.test(base);
  },

  detect(context) {
    return analyze(context) !== null;
  },

  extractRoutes(context) {
    return (analyze(context)?.operations ?? []).map((operation) => node(
      context,
      "http_contract",
      `${operation.method} ${operation.operationId ?? "operation"}`,
      `openapi:${operation.method}:${literalHash("route", operation.routePath)}`,
      operation.line,
      {
        openapi_entity: "operation",
        http_method: operation.method,
        route_path_hash: literalHash("route", operation.routePath),
        operation_id: operation.operationId,
        request_schemas: operation.requestSchemas,
        response_schemas: operation.responseSchemas,
        security: operation.security,
      },
    ));
  },

  extractModels(context) {
    return (analyze(context)?.schemas ?? []).map((schema) => node(
      context, "contract_schema", schema, `openapi:schema:${schema}`, lineOf(context.content, schema),
      { openapi_entity: "schema", schema_name: schema },
    ));
  },

  extractSupportingNodes(context) {
    const analysis = analyze(context);
    if (analysis === null) return [];
    return [
      node(context, "service", analysis.title, `openapi:service:${analysis.title}`, 1, { openapi_entity: "service" }),
      ...analysis.servers.map((server, index) => node(
        context, "external_actor", `Declared server ${index + 1}`, `openapi:server:${literalHash("server", server)}`, lineOf(context.content, server),
        { openapi_entity: "server", endpoint_hash: literalHash("server", server) },
      )),
      ...analysis.securitySchemes.map((scheme) => node(
        context, "configuration_key", scheme, `openapi:security:${scheme}`, lineOf(context.content, scheme),
        { openapi_entity: "security_scheme" },
      )),
    ];
  },

  extractFrameworkRelationships(context, entities: FrameworkEntities): GraphEdge[] {
    const analysis = analyze(context);
    if (analysis === null) return [];
    const service = entities.supporting.find((item) => item.metadata.openapi_entity === "service");
    const actors = entities.supporting.filter((item) => item.metadata.openapi_entity === "server");
    const security = new Map(entities.supporting
      .filter((item) => item.metadata.openapi_entity === "security_scheme")
      .map((item) => [item.name, item]));
    const schemas = new Map(entities.models.map((item) => [item.name, item]));
    const edges: GraphEdge[] = [...entities.routes, ...entities.models, ...entities.supporting].map((item) =>
      frameworkEdge(context, {
        edgeType: "CONTAINS", sourceNodeId: containerNodeId(context), targetNodeId: item.id,
        location: { line: item.startLine ?? 1, column: item.startColumn ?? 0 }, sourceType: "config",
        metadata: { framework: "openapi", contract_evidence: true },
      })
    );
    for (const [index, operation] of analysis.operations.entries()) {
      const operationNode = entities.routes[index];
      if (operationNode === undefined) continue;
      const location = { line: operation.line, column: 0 };
      if (service !== undefined) edges.push(frameworkEdge(context, {
        edgeType: "EXPOSES", sourceNodeId: service.id, targetNodeId: operationNode.id,
        location, sourceType: "config", metadata: { framework: "openapi", contract_evidence: true },
      }));
      for (const actor of actors) edges.push(frameworkEdge(context, {
        edgeType: "CALLS", sourceNodeId: actor.id, targetNodeId: operationNode.id,
        location, sourceType: "config", metadata: { framework: "openapi", declared_external_boundary: true },
      }));
      for (const name of operation.requestSchemas) {
        const target = schemas.get(name);
        if (target !== undefined) edges.push(frameworkEdge(context, {
          edgeType: "ACCEPTS", sourceNodeId: operationNode.id, targetNodeId: target.id,
          location, sourceType: "config", metadata: { framework: "openapi" },
        }));
      }
      for (const name of operation.responseSchemas) {
        const target = schemas.get(name);
        if (target !== undefined) edges.push(frameworkEdge(context, {
          edgeType: "RETURNS", sourceNodeId: operationNode.id, targetNodeId: target.id,
          location, sourceType: "config", metadata: { framework: "openapi" },
        }));
      }
      for (const name of operation.securityDeclared ? operation.security : analysis.defaultSecurity) {
        const target = security.get(name);
        if (target !== undefined) edges.push(frameworkEdge(context, {
          edgeType: "PROTECTED_BY", sourceNodeId: operationNode.id, targetNodeId: target.id,
          location, sourceType: "config", metadata: { framework: "openapi" },
        }));
      }
    }
    return edges;
  },
};
