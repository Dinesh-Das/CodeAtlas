import path from "node:path";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { containerNodeId, frameworkEdge, frameworkNode, literalHash } from "./graph.js";
import type { FrameworkAdapter, FrameworkEntities, RepositoryContext } from "./types.js";

interface AsyncOperation {
  channel: string;
  action: "publish" | "subscribe";
  line: number;
}

interface AsyncApiAnalysis {
  title: string;
  channels: string[];
  operations: AsyncOperation[];
  schemas: string[];
  servers: string[];
}

const analyses = new WeakMap<RepositoryContext, AsyncApiAnalysis | null>();

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function lineOf(content: string, value: string): number {
  const index = content.indexOf(value);
  return index < 0 ? 1 : content.slice(0, index).split(/\r?\n/u).length;
}

function parseJson(context: RepositoryContext): AsyncApiAnalysis | null {
  let document: Record<string, unknown>;
  try {
    document = record(JSON.parse(context.content) as unknown);
  } catch {
    return null;
  }
  if (typeof document.asyncapi !== "string") return null;
  const channels = Object.keys(record(document.channels));
  const operations: AsyncOperation[] = [];
  for (const channel of channels) {
    const definition = record(record(document.channels)[channel]);
    for (const action of ["publish", "subscribe"] as const) {
      if (Object.keys(record(definition[action])).length > 0) {
        operations.push({ channel, action, line: lineOf(context.content, `"${channel}"`) });
      }
    }
  }
  // AsyncAPI 3 names operations separately and points them at a channel.
  for (const operation of Object.values(record(document.operations))) {
    const definition = record(operation);
    const action = definition.action;
    const channelRef = record(definition.channel).$ref;
    if ((action === "send" || action === "receive") && typeof channelRef === "string") {
      const channel = channelRef.split("/").at(-1) ?? channelRef;
      operations.push({
        channel,
        action: action === "send" ? "publish" : "subscribe",
        line: lineOf(context.content, channelRef),
      });
    }
  }
  const info = record(document.info);
  return {
    title: typeof info.title === "string" ? info.title : path.posix.basename(context.relativeFilePath),
    channels: [...new Set(channels)].sort((left, right) => left.localeCompare(right)),
    operations,
    schemas: Object.keys(record(record(document.components).schemas)).sort((left, right) => left.localeCompare(right)),
    servers: Object.keys(record(document.servers)).sort((left, right) => left.localeCompare(right)),
  };
}

function parseYaml(context: RepositoryContext): AsyncApiAnalysis | null {
  if (!/^\s*asyncapi:/mu.test(context.content)) return null;
  const lines = context.content.split(/\r?\n/u);
  const channels: string[] = [];
  const operations: AsyncOperation[] = [];
  let inChannels = false;
  let channel: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (/^channels:\s*$/u.test(line)) {
      inChannels = true;
      continue;
    }
    if (inChannels && /^\S/u.test(line)) {
      inChannels = false;
      channel = null;
    }
    if (!inChannels) continue;
    const declared = /^\s{2}(['"]?)([^:'"]+)\1:\s*$/u.exec(line);
    if (declared !== null) {
      channel = declared[2]!.trim();
      channels.push(channel);
      continue;
    }
    const action = /^\s{4}(publish|subscribe):\s*$/u.exec(line)?.[1] as AsyncOperation["action"] | undefined;
    if (action !== undefined && channel !== null) operations.push({ channel, action, line: index + 1 });
  }
  const title = /^\s*title:\s*['"]?([^'"\r\n]+)['"]?\s*$/mu.exec(context.content)?.[1]?.trim() ??
    path.posix.basename(context.relativeFilePath);
  return { title, channels: [...new Set(channels)].sort(), operations, schemas: [], servers: [] };
}

function analyze(context: RepositoryContext): AsyncApiAnalysis | null {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const result = path.posix.extname(context.relativeFilePath).toLowerCase() === ".json"
    ? parseJson(context)
    : parseYaml(context);
  analyses.set(context, result);
  return result;
}

function node(context: RepositoryContext, kind: GraphNode["kind"], name: string, qualifiedName: string, line: number, metadata: Record<string, unknown>): GraphNode {
  return frameworkNode(context, {
    kind,
    name,
    qualifiedName,
    location: { line, column: 0, endLine: line, endColumn: 1 },
    framework: "asyncapi",
    sourceType: "config",
    metadata,
  });
}

export const asyncApiAdapter: FrameworkAdapter = {
  name: "asyncapi",
  version: "asyncapi-contract-1",

  supports(relativeFilePath) {
    const base = path.posix.basename(relativeFilePath).toLowerCase();
    return base.includes("asyncapi") && /\.(?:json|ya?ml)$/u.test(base);
  },

  detect(context) {
    return analyze(context) !== null;
  },

  extractRoutes(context) {
    const analysis = analyze(context);
    if (analysis === null) return [];
    return analysis.operations.map((operation, index) => node(
      context,
      "event",
      `Declared ${operation.action} ${index + 1}`,
      `asyncapi:${operation.action}:${literalHash("channel", operation.channel)}:${index}`,
      operation.line,
      {
        asyncapi_entity: "operation",
        action: operation.action,
        channel_hash: literalHash("channel", operation.channel),
      },
    ));
  },

  extractModels(context) {
    return (analyze(context)?.schemas ?? []).map((schema) => node(
      context,
      "contract_schema",
      schema,
      `asyncapi:schema:${schema}`,
      lineOf(context.content, schema),
      { asyncapi_entity: "schema", schema_name: schema },
    ));
  },

  extractSupportingNodes(context) {
    const analysis = analyze(context);
    if (analysis === null) return [];
    return [
      node(context, "service", analysis.title, `asyncapi:service:${analysis.title}`, 1, { asyncapi_entity: "service" }),
      ...analysis.channels.map((channel, index) => node(
        context,
        "topic",
        `Declared channel ${index + 1}`,
        `asyncapi:channel:${literalHash("channel", channel)}`,
        lineOf(context.content, channel),
        { asyncapi_entity: "channel", channel_hash: literalHash("channel", channel) },
      )),
      ...analysis.servers.map((server) => node(
        context,
        "external_actor",
        server,
        `asyncapi:server:${server}`,
        lineOf(context.content, server),
        { asyncapi_entity: "server" },
      )),
    ];
  },

  extractFrameworkRelationships(context, entities: FrameworkEntities): GraphEdge[] {
    const analysis = analyze(context);
    if (analysis === null) return [];
    const service = entities.supporting.find((item) => item.metadata.asyncapi_entity === "service");
    const topics = new Map(entities.supporting
      .filter((item) => item.metadata.asyncapi_entity === "channel")
      .map((item) => [item.metadata.channel_hash, item]));
    const all = [...entities.routes, ...entities.models, ...entities.supporting];
    const edges = all.map((item) => frameworkEdge(context, {
      edgeType: "CONTAINS",
      sourceNodeId: containerNodeId(context),
      targetNodeId: item.id,
      location: { line: item.startLine ?? 1, column: item.startColumn ?? 0 },
      sourceType: "config",
      metadata: { framework: "asyncapi", contract_evidence: true },
    }));
    for (const [index, operation] of analysis.operations.entries()) {
      const event = entities.routes[index];
      const topic = topics.get(literalHash("channel", operation.channel));
      if (event === undefined || topic === undefined) continue;
      edges.push(frameworkEdge(context, {
        edgeType: operation.action === "publish" ? "PUBLISHES" : "SUBSCRIBES",
        sourceNodeId: event.id,
        targetNodeId: topic.id,
        location: { line: operation.line, column: 0 },
        sourceType: "config",
        metadata: { framework: "asyncapi", contract_evidence: true },
      }));
      if (service !== undefined) edges.push(frameworkEdge(context, {
        edgeType: "EXPOSES",
        sourceNodeId: service.id,
        targetNodeId: topic.id,
        location: { line: operation.line, column: 0 },
        sourceType: "config",
        metadata: { framework: "asyncapi" },
      }));
    }
    return edges;
  },
};
