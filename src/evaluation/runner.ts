import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type EvaluationObservation,
  type EvaluationTask,
  type EvaluationVariant,
  evaluationObservationSchema,
  evaluationRunSchema,
  evaluationSuiteSchema,
} from "./models.js";

interface ConfidenceInterval {
  low: number;
  high: number;
}

interface VariantReport {
  successful_tasks: number;
  task_count: number;
  task_success_rate: number;
  task_success_rate_95ci: ConfidenceInterval;
  mean_required_file_recall: number;
  calibrated_abstention_rate: number;
  median_context_tokens: number;
  median_input_tokens: number;
  median_output_tokens: number;
  median_duration_ms: number;
  median_tool_calls: number;
  median_cost_usd: number | null;
  extraction_precision: number | null;
  extraction_recall: number | null;
  extraction_by_edge_type: Record<string, ExtractionReport>;
  extraction_by_framework: Record<string, ExtractionReport>;
  mean_explanation_support: number | null;
  mean_explanation_completeness: number | null;
  patch_tasks_measured: number;
  patch_tests_passed: number;
  patch_regressions: number;
  unnecessary_changed_files: number;
  knowledge_transfer_samples: number;
  median_time_to_locate_ms: number | null;
  flow_explanation_accuracy: number | null;
  expectation_tasks_measured: number;
  expectation_pass_rate: number | null;
}

interface ExtractionReport {
  expected_edges: number;
  found_expected_edges: number;
  reported_edges: number;
  verified_reported_edges: number;
  precision: number | null;
  recall: number | null;
}

export interface EvaluationReport {
  schema_version: 1;
  suite_id: string;
  run_id: string;
  configuration: {
    evaluator_version: string;
    model: { provider: string; id: string; version: string };
    harness: { id: string; version: string };
    cache_state: "cold" | "warm";
  } | null;
  complete: boolean;
  errors: string[];
  counts: {
    repositories: number;
    tasks: number;
    repeats: number;
    observations: number;
  };
  variants: Record<EvaluationVariant, VariantReport>;
  paired: {
    success_rate_delta: number;
    success_rate_delta_95ci: ConfidenceInterval;
    context_token_reduction: number;
    context_token_reduction_95ci: ConfidenceInterval;
    duration_reduction: number;
    duration_reduction_95ci: ConfidenceInterval;
  };
  launch_gate: {
    status: "passed" | "failed" | "incomplete";
    primary_outcome: "context_tokens" | "duration_ms";
    observed_relative_improvement: number;
    minimum_relative_improvement: number;
    observed_task_success_regression: number;
    maximum_task_success_regression: number;
  };
  repositories: Array<{
    id: string;
    tasks: number;
    native_success_rate: number;
    codeatlas_success_rate: number;
    success_rate_delta: number;
  }>;
}

interface TaskAggregate {
  task: EvaluationTask;
  repositoryId: string;
  variant: EvaluationVariant;
  success: boolean;
  successRate: number;
  evidenceRecall: number;
  calibratedAbstention: number;
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  toolCalls: number;
  costUsd: number | null;
  extractions: Array<{
    edgeType: string;
    framework: string | null;
    expected: number;
    found: number;
    reported: number;
    verified: number;
  }>;
  explanationSupport: number | null;
  explanationCompleteness: number | null;
  patchMeasured: boolean;
  patchTestsPassed: boolean;
  patchRegressions: number;
  unnecessaryChangedFiles: number;
  knowledgeTransferMeasured: boolean;
  timeToLocateMs: number;
  flowExplanationCorrect: boolean;
  expectationMeasured: boolean;
  expectationPassRate: number;
}

function rounded(value: number): number {
  return Number(value.toFixed(4));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function wilson(successes: number, count: number): ConfidenceInterval {
  if (count === 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const proportion = successes / count;
  const denominator = 1 + z * z / count;
  const center = (proportion + z * z / (2 * count)) / denominator;
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + z * z / (4 * count)) / count,
  ) / denominator;
  return { low: rounded(Math.max(0, center - margin)), high: rounded(Math.min(1, center + margin)) };
}

function createRandom(seed: string): () => number {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(percentileValue * sorted.length));
  return sorted[index] ?? 0;
}

function clusteredBootstrap(
  seed: string,
  values: readonly { repositoryId: string; value: number }[],
  statistic: (sample: readonly number[]) => number = mean,
): ConfidenceInterval {
  const repositories = [...new Set(values.map((item) => item.repositoryId))].sort();
  if (repositories.length === 0) return { low: 0, high: 0 };
  const byRepository = new Map(repositories.map((repository) => [
    repository,
    values.filter((item) => item.repositoryId === repository).map((item) => item.value),
  ]));
  const random = createRandom(seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const sample: number[] = [];
    for (let index = 0; index < repositories.length; index += 1) {
      const selected = repositories[Math.floor(random() * repositories.length)]!;
      sample.push(...(byRepository.get(selected) ?? []));
    }
    estimates.push(statistic(sample));
  }
  return { low: rounded(percentile(estimates, 0.025)), high: rounded(percentile(estimates, 0.975)) };
}

function clusteredReductionBootstrap(
  seed: string,
  values: readonly { repositoryId: string; native: number; codeatlas: number }[],
): ConfidenceInterval {
  const repositories = [...new Set(values.map((item) => item.repositoryId))].sort();
  if (repositories.length === 0) return { low: 0, high: 0 };
  const byRepository = new Map(repositories.map((repository) => [
    repository,
    values.filter((item) => item.repositoryId === repository),
  ]));
  const random = createRandom(seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const sample: Array<{ native: number; codeatlas: number }> = [];
    for (let index = 0; index < repositories.length; index += 1) {
      const selected = repositories[Math.floor(random() * repositories.length)]!;
      sample.push(...(byRepository.get(selected) ?? []));
    }
    estimates.push(relativeReduction(
      median(sample.map((item) => item.native)),
      median(sample.map((item) => item.codeatlas)),
    ));
  }
  return { low: rounded(percentile(estimates, 0.025)), high: rounded(percentile(estimates, 0.975)) };
}

function normalizeFile(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function expectationFailures(
  task: EvaluationTask,
  observation: EvaluationObservation,
): string[] {
  const expected = task.expectations;
  if (expected === undefined) return [];
  const answer = observation.answer_text?.toLocaleLowerCase() ?? "";
  const concepts = new Set((observation.concepts ?? []).map((value) => value.toLocaleLowerCase()));
  const relationships = new Set((observation.relationship_types ?? [])
    .map((value) => value.toLocaleUpperCase()));
  const startingFiles = new Set((observation.starting_files ?? []).map(normalizeFile));
  const missingConcepts = expected.required_concepts.filter((concept) => {
    const normalized = concept.toLocaleLowerCase();
    return !concepts.has(normalized) && !answer.includes(normalized);
  });
  const missingRelationships = expected.required_relationship_types.filter((type) =>
    !relationships.has(type.toLocaleUpperCase())
  );
  const startsAllowed = expected.allowed_starting_files.length === 0 ||
    expected.allowed_starting_files.some((file) => startingFiles.has(normalizeFile(file)));
  const combinedText = `${answer}\n${[...concepts].join("\n")}`;
  const distractors = expected.forbidden_distractors.filter((value) =>
    combinedText.includes(value.toLocaleLowerCase())
  );
  return [
    ...(missingConcepts.length === 0 ? [] : [`required concepts: ${missingConcepts.join(", ")}`]),
    ...(missingRelationships.length === 0
      ? []
      : [`required relationship types: ${missingRelationships.join(", ")}`]),
    ...(startsAllowed ? [] : [
      `allowed starting file: ${expected.allowed_starting_files.join(" or ")}`,
    ]),
    ...(distractors.length === 0 ? [] : [`forbidden distractors present: ${distractors.join(", ")}`]),
  ];
}

function evidenceRecall(task: EvaluationTask, evidenceFiles: readonly string[]): number {
  if (task.answerability !== "answerable") return evidenceFiles.length === 0 ? 1 : 0;
  const files = new Set(evidenceFiles.map(normalizeFile));
  return Math.max(...task.acceptable_evidence.map((set) =>
    set.files.filter((file) => files.has(normalizeFile(file))).length / set.files.length
  ));
}

function taskAggregate(
  task: EvaluationTask,
  variant: EvaluationVariant,
  observations: readonly EvaluationObservation[],
): TaskAggregate {
  const costs = observations.flatMap((observation) =>
    observation.metrics.cost_usd === null ? [] : [observation.metrics.cost_usd]
  );
  const extractions = observations.flatMap((observation) => observation.extraction ?? []);
  const explanations = observations.flatMap((observation) =>
    observation.explanation === null ? [] : [observation.explanation]
  );
  const patches = observations.flatMap((observation) =>
    observation.patch === null ? [] : [observation.patch]
  );
  const knowledgeTransfer = observations.flatMap((observation) =>
    observation.knowledge_transfer === null ? [] : [observation.knowledge_transfer]
  );
  const extractionKeys = [...new Set(extractions.map((item) =>
    `${item.edge_type}\0${item.framework ?? ""}`
  ))].sort();
  const successRate = mean(observations.map((observation) => Number(observation.success)));
  const expectationMeasured = task.expectations !== undefined;
  const expectationPassRate = expectationMeasured
    ? mean(observations.map((observation) => Number(expectationFailures(task, observation).length === 0)))
    : 0;
  return {
    task,
    repositoryId: task.repository_id,
    variant,
    success: successRate >= 0.5,
    successRate,
    evidenceRecall: median(observations.map((observation) => evidenceRecall(task, observation.evidence_files))),
    calibratedAbstention: median(observations.map((observation) =>
      Number(task.answerability === "answerable" ? !observation.abstained : observation.abstained)
    )),
    contextTokens: median(observations.map((observation) => observation.metrics.context_tokens)),
    inputTokens: median(observations.map((observation) => observation.metrics.input_tokens)),
    outputTokens: median(observations.map((observation) => observation.metrics.output_tokens)),
    durationMs: median(observations.map((observation) => observation.metrics.duration_ms)),
    toolCalls: median(observations.map((observation) => observation.metrics.tool_calls)),
    costUsd: costs.length === observations.length ? median(costs) : null,
    extractions: extractionKeys.map((key) => {
      const [edgeType = "", frameworkValue = ""] = key.split("\0");
      const matching = extractions.filter((item) =>
        item.edge_type === edgeType && (item.framework ?? "") === frameworkValue
      );
      return {
        edgeType,
        framework: frameworkValue === "" ? null : frameworkValue,
        expected: median(matching.map((item) => item.expected_edges)),
        found: median(matching.map((item) => item.found_expected_edges)),
        reported: median(matching.map((item) => item.reported_edges)),
        verified: median(matching.map((item) => item.verified_reported_edges)),
      };
    }),
    explanationSupport: explanations.length === 0 ? null : mean(explanations.map((item) => item.support)),
    explanationCompleteness: explanations.length === 0 ? null : mean(explanations.map((item) => item.completeness)),
    patchMeasured: patches.length > 0,
    patchTestsPassed: patches.length > 0 && mean(patches.map((item) => Number(item.tests_passed))) >= 0.5,
    patchRegressions: median(patches.map((item) => item.regressions)),
    unnecessaryChangedFiles: median(patches.map((item) => item.unnecessary_changed_files)),
    knowledgeTransferMeasured: knowledgeTransfer.length > 0,
    timeToLocateMs: median(knowledgeTransfer.map((item) => item.time_to_locate_ms)),
    flowExplanationCorrect: knowledgeTransfer.length > 0 &&
      mean(knowledgeTransfer.map((item) => Number(item.flow_explanation_correct))) >= 0.5,
    expectationMeasured,
    expectationPassRate,
  };
}

function extractionReport(
  extractions: readonly { expected: number; found: number; reported: number; verified: number }[],
): ExtractionReport {
  const expected = extractions.reduce((sum, item) => sum + item.expected, 0);
  const found = extractions.reduce((sum, item) => sum + item.found, 0);
  const reported = extractions.reduce((sum, item) => sum + item.reported, 0);
  const verified = extractions.reduce((sum, item) => sum + item.verified, 0);
  return {
    expected_edges: expected,
    found_expected_edges: found,
    reported_edges: reported,
    verified_reported_edges: verified,
    precision: reported === 0 ? null : rounded(verified / reported),
    recall: expected === 0 ? null : rounded(found / expected),
  };
}

function stratifiedExtraction(
  aggregates: readonly TaskAggregate[],
  field: "edgeType" | "framework",
): Record<string, ExtractionReport> {
  const extractions = aggregates.flatMap((aggregate) => aggregate.extractions);
  const keys = [...new Set(extractions.flatMap((item) => {
    const value = item[field];
    return value === null ? [] : [value];
  }))].sort();
  return Object.fromEntries(keys.map((key) => [
    key,
    extractionReport(extractions.filter((item) => item[field] === key)),
  ]));
}

function variantReport(aggregates: readonly TaskAggregate[]): VariantReport {
  const successes = aggregates.filter((aggregate) => aggregate.success).length;
  const costs = aggregates.flatMap((aggregate) => aggregate.costUsd === null ? [] : [aggregate.costUsd]);
  const extractions = aggregates.flatMap((aggregate) => aggregate.extractions);
  const extraction = extractionReport(extractions);
  const support = aggregates.flatMap((aggregate) =>
    aggregate.explanationSupport === null ? [] : [aggregate.explanationSupport]
  );
  const completeness = aggregates.flatMap((aggregate) =>
    aggregate.explanationCompleteness === null ? [] : [aggregate.explanationCompleteness]
  );
  const patchAggregates = aggregates.filter((aggregate) => aggregate.patchMeasured);
  const knowledgeTransfer = aggregates.filter((aggregate) => aggregate.knowledgeTransferMeasured);
  const expectationAggregates = aggregates.filter((aggregate) => aggregate.expectationMeasured);
  return {
    successful_tasks: successes,
    task_count: aggregates.length,
    task_success_rate: rounded(successes / Math.max(1, aggregates.length)),
    task_success_rate_95ci: wilson(successes, aggregates.length),
    mean_required_file_recall: rounded(mean(aggregates.map((aggregate) => aggregate.evidenceRecall))),
    calibrated_abstention_rate: rounded(mean(aggregates.map((aggregate) => aggregate.calibratedAbstention))),
    median_context_tokens: rounded(median(aggregates.map((aggregate) => aggregate.contextTokens))),
    median_input_tokens: rounded(median(aggregates.map((aggregate) => aggregate.inputTokens))),
    median_output_tokens: rounded(median(aggregates.map((aggregate) => aggregate.outputTokens))),
    median_duration_ms: rounded(median(aggregates.map((aggregate) => aggregate.durationMs))),
    median_tool_calls: rounded(median(aggregates.map((aggregate) => aggregate.toolCalls))),
    median_cost_usd: costs.length === aggregates.length ? rounded(median(costs)) : null,
    extraction_precision: extraction.precision,
    extraction_recall: extraction.recall,
    extraction_by_edge_type: stratifiedExtraction(aggregates, "edgeType"),
    extraction_by_framework: stratifiedExtraction(aggregates, "framework"),
    mean_explanation_support: support.length === 0 ? null : rounded(mean(support)),
    mean_explanation_completeness: completeness.length === 0 ? null : rounded(mean(completeness)),
    patch_tasks_measured: patchAggregates.length,
    patch_tests_passed: patchAggregates.filter((aggregate) => aggregate.patchTestsPassed).length,
    patch_regressions: patchAggregates.reduce((sum, aggregate) => sum + aggregate.patchRegressions, 0),
    unnecessary_changed_files: patchAggregates.reduce(
      (sum, aggregate) => sum + aggregate.unnecessaryChangedFiles,
      0,
    ),
    knowledge_transfer_samples: knowledgeTransfer.length,
    median_time_to_locate_ms: knowledgeTransfer.length === 0
      ? null
      : rounded(median(knowledgeTransfer.map((aggregate) => aggregate.timeToLocateMs))),
    flow_explanation_accuracy: knowledgeTransfer.length === 0
      ? null
      : rounded(mean(knowledgeTransfer.map((aggregate) => Number(aggregate.flowExplanationCorrect)))),
    expectation_tasks_measured: expectationAggregates.length,
    expectation_pass_rate: expectationAggregates.length === 0
      ? null
      : rounded(mean(expectationAggregates.map((aggregate) => aggregate.expectationPassRate))),
  };
}

function relativeReduction(nativeValue: number, codeAtlasValue: number): number {
  return nativeValue === 0 ? 0 : (nativeValue - codeAtlasValue) / nativeValue;
}

function emptyVariantReport(): VariantReport {
  return variantReport([]);
}

export function evaluateRun(
  suiteInput: unknown,
  runInput: unknown,
  observationInputs: readonly unknown[],
): EvaluationReport {
  const suiteResult = evaluationSuiteSchema.safeParse(suiteInput);
  const runResult = evaluationRunSchema.safeParse(runInput);
  const errors = [
    ...(suiteResult.success ? [] : suiteResult.error.issues.map((issue) =>
      `suite.${issue.path.join(".") || "root"}: ${issue.message}`
    )),
    ...(runResult.success ? [] : runResult.error.issues.map((issue) =>
      `run.${issue.path.join(".") || "root"}: ${issue.message}`
    )),
  ];
  if (!suiteResult.success || !runResult.success) {
    return {
      schema_version: 1,
      suite_id: suiteResult.success ? suiteResult.data.id : "invalid",
      run_id: runResult.success ? runResult.data.id : "invalid",
      configuration: null,
      complete: false,
      errors,
      counts: { repositories: 0, tasks: 0, repeats: 0, observations: observationInputs.length },
      variants: { native: emptyVariantReport(), codeatlas: emptyVariantReport() },
      paired: {
        success_rate_delta: 0,
        success_rate_delta_95ci: { low: 0, high: 0 },
        context_token_reduction: 0,
        context_token_reduction_95ci: { low: 0, high: 0 },
        duration_reduction: 0,
        duration_reduction_95ci: { low: 0, high: 0 },
      },
      launch_gate: {
        status: "incomplete",
        primary_outcome: "context_tokens",
        observed_relative_improvement: 0,
        minimum_relative_improvement: 0,
        observed_task_success_regression: 0,
        maximum_task_success_regression: 0,
      },
      repositories: [],
    };
  }
  const suite = suiteResult.data;
  const run = runResult.data;
  if (run.suite_id !== suite.id) errors.push(`Run targets ${run.suite_id}, not suite ${suite.id}.`);
  if (run.repeats < suite.minimum_repeats) {
    errors.push(`Run has ${run.repeats} repeats; suite requires ${suite.minimum_repeats}.`);
  }
  if (!run.variants.includes("native") || !run.variants.includes("codeatlas")) {
    errors.push("Run must pair native and codeatlas variants.");
  }

  const tasks = new Map(suite.tasks.map((task) => [task.id, task]));
  const observations: EvaluationObservation[] = [];
  const keys = new Set<string>();
  for (const [index, input] of observationInputs.entries()) {
    const parsed = evaluationObservationSchema.safeParse(input);
    if (!parsed.success) {
      errors.push(...parsed.error.issues.map((issue) =>
        `observations.${index}.${issue.path.join(".") || "root"}: ${issue.message}`
      ));
      continue;
    }
    const observation = parsed.data;
    const key = `${observation.task_id}:${observation.variant}:${observation.repeat}`;
    if (keys.has(key)) errors.push(`Duplicate observation ${key}.`);
    keys.add(key);
    if (!tasks.has(observation.task_id)) errors.push(`Unknown task ${observation.task_id}.`);
    if (observation.repeat > run.repeats) {
      errors.push(`${key} exceeds the declared ${run.repeats} repeats.`);
    }
    const task = tasks.get(observation.task_id);
    if (task !== undefined && observation.metrics.context_tokens > task.context_token_budget) {
      errors.push(`${key} exceeds its ${task.context_token_budget}-token context budget.`);
    }
    if (task !== undefined && observation.success) {
      const failures = expectationFailures(task, observation);
      if (failures.length > 0) {
        errors.push(`${key} is marked successful but misses ${failures.join("; ")}.`);
      }
    }
    observations.push(observation);
  }

  for (const task of suite.tasks) {
    for (const variant of ["native", "codeatlas"] as const) {
      for (let repeat = 1; repeat <= run.repeats; repeat += 1) {
        const key = `${task.id}:${variant}:${repeat}`;
        if (!keys.has(key)) errors.push(`Missing observation ${key}.`);
      }
    }
  }

  const aggregates: TaskAggregate[] = [];
  for (const task of suite.tasks) {
    for (const variant of ["native", "codeatlas"] as const) {
      const matching = observations.filter((observation) =>
        observation.task_id === task.id && observation.variant === variant
      );
      if (matching.length > 0) aggregates.push(taskAggregate(task, variant, matching));
    }
  }
  const nativeAggregates = aggregates.filter((aggregate) => aggregate.variant === "native");
  const codeAtlasAggregates = aggregates.filter((aggregate) => aggregate.variant === "codeatlas");
  const native = variantReport(nativeAggregates);
  const codeatlas = variantReport(codeAtlasAggregates);
  const pairs = suite.tasks.flatMap((task) => {
    const nativeAggregate = nativeAggregates.find((aggregate) => aggregate.task.id === task.id);
    const codeAtlasAggregate = codeAtlasAggregates.find((aggregate) => aggregate.task.id === task.id);
    return nativeAggregate === undefined || codeAtlasAggregate === undefined
      ? []
      : [{ task, native: nativeAggregate, codeatlas: codeAtlasAggregate }];
  });
  const successDeltas = pairs.map((pair) => ({
    repositoryId: pair.task.repository_id,
    value: Number(pair.codeatlas.success) - Number(pair.native.success),
  }));
  const contextPairs = pairs.map((pair) => ({
    repositoryId: pair.task.repository_id,
    native: pair.native.contextTokens,
    codeatlas: pair.codeatlas.contextTokens,
  }));
  const durationPairs = pairs.map((pair) => ({
    repositoryId: pair.task.repository_id,
    native: pair.native.durationMs,
    codeatlas: pair.codeatlas.durationMs,
  }));
  const paired = {
    success_rate_delta: rounded(codeatlas.task_success_rate - native.task_success_rate),
    success_rate_delta_95ci: clusteredBootstrap(`${suite.id}:success`, successDeltas),
    context_token_reduction: rounded(relativeReduction(
      native.median_context_tokens,
      codeatlas.median_context_tokens,
    )),
    context_token_reduction_95ci: clusteredReductionBootstrap(`${suite.id}:context`, contextPairs),
    duration_reduction: rounded(relativeReduction(
      native.median_duration_ms,
      codeatlas.median_duration_ms,
    )),
    duration_reduction_95ci: clusteredReductionBootstrap(`${suite.id}:duration`, durationPairs),
  };
  const observedRelativeImprovement = suite.launch_gate.primary_outcome === "context_tokens"
    ? paired.context_token_reduction
    : paired.duration_reduction;
  const successRegression = Math.max(0, native.task_success_rate - codeatlas.task_success_rate);
  const complete = errors.length === 0;
  const gatePassed = complete &&
    observedRelativeImprovement >= suite.launch_gate.minimum_relative_improvement &&
    successRegression <= suite.launch_gate.maximum_task_success_regression;
  const repositories = suite.repositories.map((repository) => {
    const nativeItems = nativeAggregates.filter((item) => item.repositoryId === repository.id);
    const codeAtlasItems = codeAtlasAggregates.filter((item) => item.repositoryId === repository.id);
    const nativeRate = mean(nativeItems.map((item) => Number(item.success)));
    const codeAtlasRate = mean(codeAtlasItems.map((item) => Number(item.success)));
    return {
      id: repository.id,
      tasks: suite.tasks.filter((task) => task.repository_id === repository.id).length,
      native_success_rate: rounded(nativeRate),
      codeatlas_success_rate: rounded(codeAtlasRate),
      success_rate_delta: rounded(codeAtlasRate - nativeRate),
    };
  });
  return {
    schema_version: 1,
    suite_id: suite.id,
    run_id: run.id,
    configuration: {
      evaluator_version: run.evaluator_version,
      model: run.model,
      harness: run.harness,
      cache_state: run.cache_state,
    },
    complete,
    errors,
    counts: {
      repositories: suite.repositories.length,
      tasks: suite.tasks.length,
      repeats: run.repeats,
      observations: observations.length,
    },
    variants: { native, codeatlas },
    paired,
    launch_gate: {
      status: complete ? (gatePassed ? "passed" : "failed") : "incomplete",
      primary_outcome: suite.launch_gate.primary_outcome,
      observed_relative_improvement: rounded(observedRelativeImprovement),
      minimum_relative_improvement: suite.launch_gate.minimum_relative_improvement,
      observed_task_success_regression: rounded(successRegression),
      maximum_task_success_regression: suite.launch_gate.maximum_task_success_regression,
    },
    repositories,
  };
}

async function fixtureFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".codeatlas" || entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await fixtureFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return files;
}

export async function fixtureContentSha256(root: string): Promise<string> {
  if (!(await stat(root)).isDirectory()) throw new Error(`${root} is not a directory.`);
  const hash = createHash("sha256");
  for (const relativePath of await fixtureFiles(root)) {
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(await readFile(path.join(root, ...relativePath.split("/"))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function validatePinnedFixtures(
  suiteInput: unknown,
  workspaceRoot: string,
): Promise<string[]> {
  const parsed = evaluationSuiteSchema.safeParse(suiteInput);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) =>
      `suite.${issue.path.join(".") || "root"}: ${issue.message}`
    );
  }
  const errors: string[] = [];
  const repositoryRoots = new Map<string, string>();
  for (const repository of parsed.data.repositories) {
    const root = path.resolve(workspaceRoot, ...repository.fixture_root.split("/"));
    const workspaceRelative = path.relative(workspaceRoot, root);
    if (workspaceRelative.startsWith("..") || path.isAbsolute(workspaceRelative)) {
      errors.push(`${repository.id}: fixture root escapes the evaluation workspace.`);
      continue;
    }
    repositoryRoots.set(repository.id, root);
    let actual: string;
    try {
      actual = await fixtureContentSha256(root);
    } catch (error) {
      errors.push(`${repository.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (actual !== repository.content_sha256) {
      errors.push(`${repository.id}: content SHA-256 ${actual} does not match ${repository.content_sha256}.`);
    }
  }
  for (const task of parsed.data.tasks) {
    const root = repositoryRoots.get(task.repository_id);
    if (root === undefined) continue;
    for (const evidenceFile of new Set(
      task.acceptable_evidence.flatMap((evidence) => evidence.files),
    )) {
      const candidate = path.resolve(root, ...evidenceFile.split("/"));
      const fixtureRelative = path.relative(root, candidate);
      if (fixtureRelative.startsWith("..") || path.isAbsolute(fixtureRelative)) {
        errors.push(`${task.id}: evidence file ${evidenceFile} escapes its fixture root.`);
        continue;
      }
      try {
        if (!(await stat(candidate)).isFile()) {
          errors.push(`${task.id}: evidence path ${evidenceFile} is not a file.`);
        }
      } catch {
        errors.push(`${task.id}: evidence file ${evidenceFile} does not exist.`);
      }
    }
  }
  return errors;
}
