import { z } from "zod";
import { sha256 } from "../core/hashing.js";
import { createEdgeId } from "../graph/ids.js";
import { EDGE_TYPES, type EdgeType, type GraphEdge, type GraphNode } from "../graph/types.js";
import type { AtlasDatabase } from "../storage/database.js";
import { upsertEdge } from "../storage/edges.js";
import { frameworkNode } from "./graph.js";
import type { FrameworkAdapter, FrameworkEntities, RepositoryContext } from "./types.js";

const OBSERVABLE_EDGE_TYPES = EDGE_TYPES.filter((type) => ![
  "BELONGS_TO_DOMAIN",
  "BELONGS_TO_FEATURE",
  "CONTAINS",
  "EXPORTS",
  "RENAMED_FROM",
].includes(type));

const relationshipSchema = z.object({
  source: z.string().trim().min(1).max(500),
  target: z.string().trim().min(1).max(500),
  type: z.enum(OBSERVABLE_EDGE_TYPES as [EdgeType, ...EdgeType[]]),
  confidence: z.number().min(0.5).max(1).default(1),
  observation: z.enum(["instrumentation", "trace", "profile", "test"]).default("instrumentation"),
  count: z.number().int().positive().optional(),
}).strict();

const manifestSchema = z.object({
  version: z.literal(1),
  relationships: z.array(relationshipSchema).max(50_000),
}).strict();

type RuntimeRelationship = z.infer<typeof relationshipSchema>;

interface RuntimeAnalysis {
  relationships: Array<RuntimeRelationship & { line: number }>;
}

const analyses = new WeakMap<RepositoryContext, RuntimeAnalysis | null>();

function analyze(context: RepositoryContext): RuntimeAnalysis | null {
  const cached = analyses.get(context);
  if (cached !== undefined) return cached;
  if (!/(?:^|\/)codeatlas\.runtime\.json$/u.test(context.relativeFilePath)) {
    analyses.set(context, null);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(context.content) as unknown;
  } catch {
    analyses.set(context, null);
    return null;
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid runtime evidence manifest: ${result.error.message}`);
  let searchOffset = 0;
  const relationships = result.data.relationships.map((relationship) => {
    const needle = JSON.stringify(relationship.source);
    const offset = context.content.indexOf(needle, searchOffset);
    if (offset >= 0) searchOffset = offset + needle.length;
    const line = offset < 0 ? 1 : context.content.slice(0, offset).split(/\r?\n/u).length;
    return { ...relationship, line };
  });
  const analysis = { relationships };
  analyses.set(context, analysis);
  return analysis;
}

function observationNode(
  context: RepositoryContext,
  relationship: RuntimeAnalysis["relationships"][number],
  index: number,
): GraphNode {
  const selectorHash = sha256(`${relationship.source}\0${relationship.target}`);
  return frameworkNode(context, {
    kind: "configuration",
    name: `Observed ${relationship.type} relationship`,
    qualifiedName: `runtime-evidence:${index}:${selectorHash.slice(0, 16)}`,
    location: {
      line: relationship.line,
      column: 0,
      endLine: relationship.line,
      endColumn: 1,
    },
    framework: "codeatlas-runtime-evidence",
    sourceType: "config",
    confidence: relationship.confidence,
    metadata: {
      runtime_evidence: true,
      source_selector: relationship.source,
      target_selector: relationship.target,
      relationship_type: relationship.type,
      observation: relationship.observation,
      observation_count: relationship.count ?? null,
      selector_hash: selectorHash,
    },
  });
}

export const runtimeEvidenceAdapter: FrameworkAdapter = {
  name: "codeatlas-runtime-evidence",
  version: "runtime-evidence-1",

  supports(relativeFilePath) {
    return /(?:^|\/)codeatlas\.runtime\.json$/u.test(relativeFilePath);
  },

  detect(context) {
    return analyze(context) !== null;
  },

  extractRoutes() {
    return [];
  },

  extractModels() {
    return [];
  },

  extractSupportingNodes(context) {
    return (analyze(context)?.relationships ?? []).map((relationship, index) =>
      observationNode(context, relationship, index)
    );
  },

  extractFrameworkRelationships(_context, _entities: FrameworkEntities) {
    return [];
  },
};

interface ObservationRow {
  id: string;
  file_path: string;
  start_line: number;
  confidence: number;
  metadata_json: string;
}

function selectorCandidates(
  database: AtlasDatabase,
  selector: string,
): Array<{ id: string; qualified_name: string | null }> {
  const exact = database
    .prepare(
      `SELECT id, qualified_name FROM nodes
       WHERE kind IN ('class', 'interface', 'function', 'method', 'variable', 'service', 'process', 'job')
         AND qualified_name = ? ORDER BY id`,
    )
    .all(selector) as Array<{ id: string; qualified_name: string | null }>;
  if (exact.length > 0) return exact;
  const name = selector.split(/\.|::|#/u).at(-1) ?? selector;
  return database
    .prepare(
      `SELECT id, qualified_name FROM nodes
       WHERE kind IN ('class', 'interface', 'function', 'method', 'variable', 'service', 'process', 'job')
         AND name = ? ORDER BY id`,
    )
    .all(name) as Array<{ id: string; qualified_name: string | null }>;
}

/** Materialize only uniquely matched observations; ambiguous selectors remain visible config facts. */
export function materializeRuntimeEvidence(
  database: AtlasDatabase,
  repositoryId: string,
  timestamp: string,
): number {
  const observations = database
    .prepare(
      `SELECT id, file_path, start_line, confidence, metadata_json
       FROM nodes
       WHERE kind = 'configuration'
         AND json_extract(metadata_json, '$.runtime_evidence') = 1
       ORDER BY file_path, start_line, id`,
    )
    .all() as ObservationRow[];
  let written = 0;
  for (const observation of observations) {
    const metadata = JSON.parse(observation.metadata_json) as Record<string, unknown>;
    const sourceSelector = metadata.source_selector;
    const targetSelector = metadata.target_selector;
    const edgeType = metadata.relationship_type;
    if (
      typeof sourceSelector !== "string" ||
      typeof targetSelector !== "string" ||
      typeof edgeType !== "string" ||
      !OBSERVABLE_EDGE_TYPES.includes(edgeType as EdgeType)
    ) continue;
    const sources = selectorCandidates(database, sourceSelector);
    const targets = selectorCandidates(database, targetSelector);
    if (sources.length !== 1 || targets.length !== 1) continue;
    const source = sources[0]!;
    const target = targets[0]!;
    const edge: GraphEdge = {
      id: createEdgeId(
        repositoryId,
        edgeType as EdgeType,
        source.id,
        target.id,
        observation.file_path,
        observation.start_line,
      ),
      sourceNodeId: source.id,
      targetNodeId: target.id,
      edgeType: edgeType as EdgeType,
      sourceType: "config",
      provenance: "verified",
      confidence: observation.confidence,
      filePath: observation.file_path,
      line: observation.start_line,
      metadata: {
        evidence: {
          source_type: "config",
          file: observation.file_path,
          line: observation.start_line,
          column: 0,
        },
        evidence_class: "runtime_observation",
        observation: metadata.observation,
        observation_count: metadata.observation_count,
        selector_hash: metadata.selector_hash,
        source_resolution: source.qualified_name,
        target_resolution: target.qualified_name,
      },
    };
    upsertEdge(database, edge, timestamp, "framework_projection");
    written += 1;
  }
  return written;
}
