import { z } from "zod";
import { ARCHITECTURAL_SCOPES } from "../analysis/scope.js";
import { ATLAS_PROVENANCE, ATLAS_SCHEMA_VERSION } from "./models.js";

const locationSchema = z.object({
  start_line: z.number().int().positive(),
  start_column: z.number().int().nonnegative(),
  end_line: z.number().int().positive(),
  end_column: z.number().int().nonnegative(),
}).strict();

export const atlasSymbolSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string(),
  qualified_name: z.string().nullable(),
  file: z.string().nullable(),
  scope: z.enum(ARCHITECTURAL_SCOPES).optional(),
  language: z.string().nullable(),
  location: locationSchema.nullable(),
  domain_ids: z.array(z.string()),
  visibility: z.string().nullable(),
  signature: z.string().nullable(),
  content_hash: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  provenance: z.enum(ATLAS_PROVENANCE),
  fact_class: z.enum(["EXTRACTED", "RESOLVED", "INFERRED"]),
  evidence_ids: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
}).strict();

export const atlasRelationshipSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1),
  confidence: z.number().min(0).max(1),
  provenance: z.enum(ATLAS_PROVENANCE),
  fact_class: z.enum(["EXTRACTED", "RESOLVED", "INFERRED"]),
  evidence_ids: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
}).strict();

export const atlasEvidenceSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  start_line: z.number().int().positive(),
  start_column: z.number().int().nonnegative(),
  end_line: z.number().int().positive(),
  end_column: z.number().int().nonnegative(),
  symbol_id: z.string().nullable(),
  relationship_id: z.string().nullable(),
  kind: z.enum(["source", "config", "git", "documentation"]),
  excerpt: z.string().nullable(),
  content_hash: z.string().nullable(),
}).strict();

export const atlasSchema = z.object({
  schema_version: z.literal(ATLAS_SCHEMA_VERSION),
  generator: z.object({
    name: z.literal("CodeAtlas"),
    version: z.string().min(1),
    indexer_version: z.string().min(1),
  }).strict(),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    root: z.string(),
    git_commit: z.string().nullable(),
    git_branch: z.string().nullable(),
    dirty: z.boolean(),
  }).strict(),
  snapshot: z.object({ id: z.string().min(1), created_at: z.string().min(1) }).strict(),
  symbols: z.array(atlasSymbolSchema),
  relationships: z.array(atlasRelationshipSchema),
  evidence: z.array(atlasEvidenceSchema),
  domains: z.array(z.unknown()),
  entrypoint_ids: z.array(z.string()),
  flows: z.array(z.unknown()),
  control_flows: z.array(z.unknown()),
  impact: z.object({
    forward: z.record(z.string(), z.array(z.string())),
    reverse: z.record(z.string(), z.array(z.string())),
    scores: z.array(z.unknown()),
  }).strict(),
  git_changes: z.array(z.unknown()),
  rules: z.array(z.unknown()),
  rule_violations: z.array(z.unknown()),
  review_findings: z.array(z.unknown()),
  statistics: z.object({
    files: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    relationships: z.number().int().nonnegative(),
    domains: z.number().int().nonnegative(),
    entrypoints: z.number().int().nonnegative(),
    flows: z.number().int().nonnegative(),
    control_flows: z.number().int().nonnegative(),
    rule_violations: z.number().int().nonnegative(),
    review_findings: z.number().int().nonnegative(),
  }).strict(),
}).strict();
