import { z } from "zod";
import {
  EDGE_TYPES,
  PROVENANCE_CATEGORIES,
  SOURCE_TYPES,
} from "../graph/types.js";

export const evidenceSchema = z
  .object({
    file: z.string(),
    line: z.number().int().positive(),
    column: z.number().int().nonnegative().optional(),
  })
  .strict();

export const answerPacketSchema = z
  .object({
    answer_context: z
      .object({
        topic: z.string(),
        tool: z.string(),
      })
      .strict(),
    facts: z.array(
      z
        .object({
          statement: z.string(),
          confidence: z.number().min(0).max(1),
          source_type: z.enum(SOURCE_TYPES),
          provenance: z.enum(PROVENANCE_CATEGORIES).default("verified"),
          evidence: evidenceSchema,
        })
        .strict(),
    ),
    relationships: z.array(
      z
        .object({
          source_node_id: z.string(),
          target_node_id: z.string(),
          edge_type: z.enum(EDGE_TYPES),
          confidence: z.number().min(0).max(1),
          source_type: z.enum(SOURCE_TYPES),
          provenance: z.enum(PROVENANCE_CATEGORIES).default("verified"),
          evidence: evidenceSchema.omit({ column: true }),
          source: z
            .object({
              node_id: z.string(),
              name: z.string(),
              qualified_name: z.string().nullable(),
              file: z.string().nullable(),
              line: z.number().int().positive().nullable(),
            })
            .strict()
            .optional(),
          target: z
            .object({
              node_id: z.string(),
              name: z.string(),
              qualified_name: z.string().nullable(),
              file: z.string().nullable(),
              line: z.number().int().positive().nullable(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    source_snippets: z.array(
      z
        .object({
          node_id: z.string(),
          file: z.string(),
          start_line: z.number().int().positive(),
          end_line: z.number().int().positive(),
          content: z.string(),
          trust: z.literal("untrusted_repository_content"),
        })
        .strict(),
    ),
    uncertainties: z.array(
      z
        .object({
          description: z.string(),
          reason: z.enum([
            "unresolved_reference",
            "insufficient_evidence",
            "heuristic_only",
            "multi_candidate",
            "dynamic_relationship",
            "generated_code",
            "unsupported_framework",
          ]),
          candidates: z.array(z.string()),
        })
        .strict(),
    ),
    freshness: z
      .object({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        head_commit: z.string(),
        mode: z.enum(["authoritative", "watch_cache"]),
        working_tree_checked: z.boolean(),
        checked_at: z.string().datetime(),
        authoritative_checked_at: z.string().datetime(),
        request_at: z.string().datetime(),
        cache_invalidated: z.boolean(),
        reconciliation_max_age_ms: z.number().int().positive(),
        structural_generation: z.number().int().nonnegative(),
        semantic_generation: z.number().int().nonnegative(),
        search_generation: z.number().int().nonnegative(),
        architecture_generation: z.number().int().nonnegative(),
        semantic_current: z.boolean(),
        search_current: z.boolean(),
        architecture_current: z.boolean(),
      })
      .strict(),
    security: z
      .object({
        indexing: z.literal("local_only"),
        repository_content: z.literal("untrusted"),
        answer_policy: z.literal("evidence_only"),
        external_llm_behavior: z.literal("outside_codeatlas"),
      })
      .strict()
      .default({
        indexing: "local_only",
        repository_content: "untrusted",
        answer_policy: "evidence_only",
        external_llm_behavior: "outside_codeatlas",
      }),
    pagination: z
      .object({
        cursor: z.string().nullable(),
        has_more: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type AnswerPacket = z.infer<typeof answerPacketSchema>;

export const paginationInputShape = {
  cursor: z.string().nullable().optional().default(null),
  limit: z.number().int().positive().max(10_000).optional().default(50),
};

export const emptyInputSchema = z.object({}).strict();
export const overviewInputSchema = z.object(paginationInputShape).strict();
export const searchInputSchema = z
  .object({ query: z.string().min(1), ...paginationInputShape })
  .strict();
export const getNodeInputSchema = z.object({ node_id: z.string().min(1) }).strict();
export const explainFeatureInputSchema = z
  .object({ feature: z.string().min(1), ...paginationInputShape })
  .strict();
export const traceInputSchema = z
  .object({
    start: z.string().min(1),
    max_depth: z.number().int().positive().max(100).optional().default(8),
    ...paginationInputShape,
  })
  .strict();
export const impactInputSchema = z
  .object({ target: z.string().min(1), ...paginationInputShape })
  .strict();
export const dependenciesInputSchema = z
  .object({
    target: z.string().min(1),
    direction: z.enum(["incoming", "outgoing", "both"]).optional().default("both"),
    ...paginationInputShape,
  })
  .strict();
export const sourceInputSchema = z.object({ node_id: z.string().min(1) }).strict();
export const healthInputSchema = z.object(paginationInputShape).strict();
