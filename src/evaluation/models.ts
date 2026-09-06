import { z } from "zod";

export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const EVALUATION_HARNESS_VERSION = "1.1.0";

export const evaluationVariantSchema = z.enum(["native", "codeatlas"]);
export const evaluationTaskCategorySchema = z.enum([
  "architecture_explanation",
  "change_location",
  "cross_file_bug_fix",
  "refactoring",
  "affected_tests",
  "unanswerable",
]);
export const evaluationAnswerabilitySchema = z.enum([
  "answerable",
  "unanswerable",
]);

const pinnedRepositorySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/u),
  fixture_root: z.string().min(1),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  license: z.string().min(1),
  languages: z.array(z.enum(["typescript", "javascript", "python", "unsupported"])).min(1),
  negative_coverage: z.boolean(),
}).strict();

const evidenceSetSchema = z.object({
  description: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
}).strict();

const taskExpectationsSchema = z.object({
  required_concepts: z.array(z.string().min(1)),
  required_relationship_types: z.array(z.string().min(1)),
  allowed_starting_files: z.array(z.string().min(1)),
  forbidden_distractors: z.array(z.string().min(1)),
}).strict();

const evaluationTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,99}$/u),
  repository_id: z.string().min(1),
  category: evaluationTaskCategorySchema,
  prompt: z.string().min(10),
  answerability: evaluationAnswerabilitySchema,
  codeatlas_coverage: z.enum(["supported", "out_of_coverage"]).default("supported"),
  context_token_budget: z.number().int().positive(),
  acceptable_evidence: z.array(evidenceSetSchema),
  expectations: taskExpectationsSchema.optional(),
  expected_behavior: z.string().min(1),
  patch_test: z.string().min(1).nullable(),
}).strict().superRefine((task, context) => {
  if (task.answerability === "answerable" && task.acceptable_evidence.length === 0) {
    context.addIssue({
      code: "custom",
      message: "Answerable tasks require at least one acceptable evidence set.",
      path: ["acceptable_evidence"],
    });
  }
  if (task.answerability === "unanswerable" && task.acceptable_evidence.length > 0) {
    context.addIssue({
      code: "custom",
      message: "Unanswerable tasks must not prescribe evidence.",
      path: ["acceptable_evidence"],
    });
  }
});

const launchGateSchema = z.object({
  primary_outcome: z.enum(["context_tokens", "duration_ms"]),
  minimum_relative_improvement: z.number().min(0).max(1),
  maximum_task_success_regression: z.number().min(0).max(1),
}).strict();

export const evaluationSuiteSchema = z.object({
  schema_version: z.literal(EVALUATION_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,99}$/u),
  title: z.string().min(1),
  visibility: z.enum(["development", "held_out"]),
  minimum_repeats: z.number().int().min(3),
  repositories: z.array(pinnedRepositorySchema).min(1),
  tasks: z.array(evaluationTaskSchema).min(1),
  launch_gate: launchGateSchema,
}).strict().superRefine((suite, context) => {
  const repositoryIds = new Set<string>();
  for (const [index, repository] of suite.repositories.entries()) {
    if (repositoryIds.has(repository.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate repository ID ${repository.id}.`,
        path: ["repositories", index, "id"],
      });
    }
    repositoryIds.add(repository.id);
  }
  const taskIds = new Set<string>();
  for (const [index, task] of suite.tasks.entries()) {
    if (taskIds.has(task.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate task ID ${task.id}.`,
        path: ["tasks", index, "id"],
      });
    }
    taskIds.add(task.id);
    if (!repositoryIds.has(task.repository_id)) {
      context.addIssue({
        code: "custom",
        message: `Unknown repository ID ${task.repository_id}.`,
        path: ["tasks", index, "repository_id"],
      });
    }
  }
});

const exactVersionSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  version: z.string().min(1),
}).strict();

export const evaluationRunSchema = z.object({
  schema_version: z.literal(EVALUATION_SCHEMA_VERSION),
  evaluator_version: z.literal(EVALUATION_HARNESS_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,119}$/u),
  suite_id: z.string().min(1),
  created_at: z.string().datetime({ offset: true }),
  model: exactVersionSchema,
  harness: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }).strict(),
  cache_state: z.enum(["cold", "warm"]),
  repeats: z.number().int().min(3),
  variants: z.array(evaluationVariantSchema).length(2).refine(
    (variants) => new Set(variants).size === 2,
    "A paired run must contain native and codeatlas variants.",
  ),
}).strict();

const metricsSchema = z.object({
  context_tokens: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative(),
  tool_calls: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative().nullable(),
}).strict();

const extractionMeasurementSchema = z.object({
  edge_type: z.string().min(1),
  framework: z.string().min(1).nullable(),
  expected_edges: z.number().int().nonnegative(),
  found_expected_edges: z.number().int().nonnegative(),
  reported_edges: z.number().int().nonnegative(),
  verified_reported_edges: z.number().int().nonnegative(),
}).strict().refine(
  (measurement) => measurement.found_expected_edges <= measurement.expected_edges &&
    measurement.verified_reported_edges <= measurement.reported_edges,
  "Extraction counts cannot exceed their denominators.",
);

const explanationMeasurementSchema = z.object({
  support: z.number().min(0).max(1),
  completeness: z.number().min(0).max(1),
  independently_reviewed: z.boolean(),
}).strict();

const patchMeasurementSchema = z.object({
  tests_passed: z.boolean(),
  regressions: z.number().int().nonnegative(),
  unnecessary_changed_files: z.number().int().nonnegative(),
}).strict();

const knowledgeTransferMeasurementSchema = z.object({
  time_to_locate_ms: z.number().nonnegative(),
  flow_explanation_correct: z.boolean(),
}).strict();

export const evaluationObservationSchema = z.object({
  schema_version: z.literal(EVALUATION_SCHEMA_VERSION),
  task_id: z.string().min(1),
  variant: evaluationVariantSchema,
  repeat: z.number().int().positive(),
  success: z.boolean(),
  abstained: z.boolean(),
  evidence_files: z.array(z.string().min(1)),
  answer_text: z.string().optional(),
  concepts: z.array(z.string().min(1)).optional(),
  relationship_types: z.array(z.string().min(1)).optional(),
  starting_files: z.array(z.string().min(1)).optional(),
  metrics: metricsSchema,
  extraction: z.array(extractionMeasurementSchema).nullable(),
  explanation: explanationMeasurementSchema.nullable(),
  patch: patchMeasurementSchema.nullable(),
  knowledge_transfer: knowledgeTransferMeasurementSchema.nullable(),
}).strict();

export type EvaluationVariant = z.infer<typeof evaluationVariantSchema>;
export type EvaluationTask = z.infer<typeof evaluationTaskSchema>;
export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;
export type EvaluationRun = z.infer<typeof evaluationRunSchema>;
export type EvaluationObservation = z.infer<typeof evaluationObservationSchema>;
