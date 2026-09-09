import path from "node:path";
import type { GraphEdge, GraphNode, NodeKind, SourceType } from "../graph/types.js";
import { containerNodeId, frameworkEdge, frameworkNode, literalHash } from "./graph.js";
import type { FrameworkAdapter, FrameworkEntities, RepositoryContext } from "./types.js";

interface DeploymentEntity {
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  line: number;
  sourceType: SourceType;
  metadata: Record<string, unknown>;
}

const DATASTORE_IMAGES = /(?:postgres|mysql|mariadb|mongo|redis|cassandra|cockroach|elasticsearch|opensearch|neo4j|dynamodb)/iu;
const analyses = new WeakMap<RepositoryContext, DeploymentEntity[]>();

function lineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r?\n/u).length;
}

function composeEntities(context: RepositoryContext): DeploymentEntity[] {
  const entities: DeploymentEntity[] = [];
  const servicesStart = /^services:\s*$/mu.exec(context.content);
  if (servicesStart === null) return entities;
  const start = servicesStart.index + servicesStart[0].length;
  const rest = context.content.slice(start);
  const endMatch = /^\S[^:\r\n]*:\s*$/mu.exec(rest);
  const section = rest.slice(0, endMatch?.index ?? rest.length);
  const declarations = [...section.matchAll(/^\s{2}([A-Za-z0-9_.-]+):\s*$/gmu)];
  for (const [index, declaration] of declarations.entries()) {
    const name = declaration[1]!;
    const bodyStart = (declaration.index ?? 0) + declaration[0].length;
    const bodyEnd = declarations[index + 1]?.index ?? section.length;
    const body = section.slice(bodyStart, bodyEnd);
    const absoluteOffset = start + (declaration.index ?? 0);
    const line = lineNumber(context.content, absoluteOffset);
    const nameHash = literalHash("compose_service", name);
    entities.push({
      kind: "service",
      name,
      qualifiedName: `compose:service:${nameHash}`,
      line,
      sourceType: "config",
      metadata: { deployment_entity: "compose_service", service_hash: nameHash },
    });
    const image = /^\s{4}image:\s*['"]?([^'"\s#]+)['"]?/mu.exec(body)?.[1] ?? "";
    if (DATASTORE_IMAGES.test(`${name} ${image}`)) {
      entities.push({
        kind: "datastore",
        name,
        qualifiedName: `compose:datastore:${nameHash}`,
        line,
        sourceType: "heuristic",
        metadata: {
          deployment_entity: "datastore",
          service_hash: nameHash,
          classification: "well_known_datastore_image_or_service",
        },
      });
    }
    for (const match of body.matchAll(/^\s{6,}-?\s*([A-Z][A-Z0-9_]*)\s*(?:=|:)/gmu)) {
      const variable = match[1]!;
      entities.push({
        kind: "environment_variable",
        name: variable,
        qualifiedName: `compose:environment:${nameHash}:${variable}`,
        line: lineNumber(context.content, start + bodyStart + (match.index ?? 0)),
        sourceType: "config",
        metadata: { deployment_entity: "environment_variable", owner_hash: nameHash },
      });
    }
  }
  return entities;
}

function kubernetesEntities(context: RepositoryContext): DeploymentEntity[] {
  const entities: DeploymentEntity[] = [];
  let offset = 0;
  for (const document of context.content.split(/^---\s*$/gmu)) {
    const kind = /^kind:\s*['"]?([A-Za-z]+)['"]?\s*$/mu.exec(document)?.[1];
    const name = /^metadata:\s*$[\s\S]*?^\s{2}name:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/mu.exec(document)?.[1];
    if (kind !== undefined && name !== undefined) {
      const lower = kind.toLowerCase();
      const nodeKind: NodeKind = lower === "job" || lower === "cronjob"
        ? "job"
        : lower === "service"
          ? "service"
          : ["deployment", "statefulset", "daemonset", "pod"].includes(lower)
            ? "process"
            : "configuration";
      const line = lineNumber(context.content, offset + (document.indexOf(`kind:`)));
      entities.push({
        kind: nodeKind,
        name,
        qualifiedName: `kubernetes:${lower}:${literalHash("manifest_name", name)}`,
        line,
        sourceType: "config",
        metadata: { deployment_entity: "kubernetes_resource", resource_kind: kind },
      });
      for (const match of document.matchAll(/^\s*-\s*name:\s*['"]?([A-Z][A-Z0-9_]*)['"]?\s*$/gmu)) {
        const variable = match[1]!;
        entities.push({
          kind: "environment_variable",
          name: variable,
          qualifiedName: `kubernetes:environment:${literalHash("manifest_name", name)}:${variable}`,
          line: lineNumber(context.content, offset + (match.index ?? 0)),
          sourceType: "config",
          metadata: { deployment_entity: "environment_variable", resource_kind: kind },
        });
      }
    }
    offset += document.length + 4;
  }
  return entities;
}

function analyze(context: RepositoryContext): DeploymentEntity[] {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  const base = path.posix.basename(context.relativeFilePath).toLowerCase();
  const result = /^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/u.test(base)
    ? composeEntities(context)
    : kubernetesEntities(context);
  analyses.set(context, result);
  return result;
}

function deploymentNode(context: RepositoryContext, entity: DeploymentEntity): GraphNode {
  return frameworkNode(context, {
    kind: entity.kind,
    name: entity.name,
    qualifiedName: entity.qualifiedName,
    location: { line: entity.line, column: 0, endLine: entity.line, endColumn: 1 },
    framework: "deployment",
    sourceType: entity.sourceType,
    confidence: entity.sourceType === "heuristic" ? 0.85 : 1,
    metadata: entity.metadata,
  });
}

export const deploymentAdapter: FrameworkAdapter = {
  name: "deployment",
  version: "deployment-manifest-1",

  supports(relativeFilePath, language) {
    const base = path.posix.basename(relativeFilePath).toLowerCase();
    return language === "yaml" && (
      /^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/u.test(base) ||
      /(?:deploy|deployment|manifest|k8s|kubernetes)/u.test(relativeFilePath.toLowerCase())
    );
  },

  detect(context) {
    return analyze(context).length > 0;
  },

  extractRoutes() {
    return [];
  },

  extractModels(context) {
    return analyze(context).map((entity) => deploymentNode(context, entity));
  },

  extractFrameworkRelationships(context, entities: FrameworkEntities): GraphEdge[] {
    return entities.models.map((item) => frameworkEdge(context, {
      edgeType: "CONTAINS",
      sourceNodeId: containerNodeId(context),
      targetNodeId: item.id,
      location: { line: item.startLine ?? 1, column: 0 },
      sourceType: item.sourceType,
      confidence: item.confidence,
      metadata: { framework: "deployment", deployment_evidence: true },
    }));
  },
};
