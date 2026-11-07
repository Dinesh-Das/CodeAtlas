import { createHash } from "node:crypto";
import { z } from "zod";
import {
  answerReviewSchema, evaluationObservationSchema, evaluationVariantSchema,
  type AnswerReview, type EvaluationObservation, type EvaluationSuite, type EvaluationTask, type EvaluationVariant,
} from "./models.js";

export const providerAnswerSchema = z.object({
  answer_text: z.string(),
  abstained: z.boolean(),
  evidence_files: z.array(z.string()),
  concepts: z.array(z.string()),
  relationship_types: z.array(z.string()),
  starting_files: z.array(z.string()),
}).strict();

export type ProviderAnswer = z.infer<typeof providerAnswerSchema>;

function normalizeFile(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function evidenceRecall(task: EvaluationTask, files: readonly string[]): number {
  if (task.answerability === "unanswerable") return files.length === 0 ? 1 : 0;
  const actual = new Set(files.map(normalizeFile));
  return Math.max(...task.acceptable_evidence.map((set) =>
    set.files.filter((file) => actual.has(normalizeFile(file))).length / set.files.length
  ));
}

export function providerExpectationFailures(task: EvaluationTask, answer: ProviderAnswer): string[] {
  const expectations = task.expectations;
  if (expectations === undefined) return [];
  const text = answer.answer_text.toLowerCase();
  const relationships = new Set(answer.relationship_types.map((item) => item.toUpperCase()));
  const starts = new Set(answer.starting_files.map(normalizeFile));
  const missingConcepts = expectations.required_concepts.filter((concept) => !text.includes(concept.toLowerCase()));
  const missingRelationships = expectations.required_relationship_types.filter((type) => !relationships.has(type.toUpperCase()));
  const startsAllowed = expectations.allowed_starting_files.length === 0 ||
    expectations.allowed_starting_files.some((file) => starts.has(normalizeFile(file)));
  const combinedText = `${text}\n${answer.concepts.join("\n").toLowerCase()}`;
  const distractors = expectations.forbidden_distractors.filter((value) => combinedText.includes(value.toLowerCase()));
  return [
    ...(missingConcepts.length === 0 ? [] : [`required concepts: ${missingConcepts.join(", ")}`]),
    ...(missingRelationships.length === 0 ? [] : [`required relationship types: ${missingRelationships.join(", ")}`]),
    ...(startsAllowed ? [] : [`allowed starting file: ${expectations.allowed_starting_files.join(" or ")}`]),
    ...(distractors.length === 0 ? [] : [`forbidden distractors present: ${distractors.join(", ")}`]),
  ];
}

export function scoreProviderEvidence(task: EvaluationTask, answer: ProviderAnswer): boolean {
  if (task.answerability === "unanswerable") {
    return answer.abstained && answer.evidence_files.length === 0;
  }
  return !answer.abstained && evidenceRecall(task, answer.evidence_files) === 1;
}

export function answerFromObservation(observation: EvaluationObservation): ProviderAnswer {
  return {
    answer_text: observation.answer_text ?? "", abstained: observation.abstained,
    evidence_files: observation.evidence_files, concepts: observation.concepts ?? [],
    relationship_types: observation.relationship_types ?? [], starting_files: observation.starting_files ?? [],
  };
}

export function answerReviewDigest(task: EvaluationTask, answer: ProviderAnswer): string {
  const canonical = providerAnswerSchema.parse(answer);
  canonical.evidence_files = canonical.evidence_files.map(normalizeFile);
  canonical.starting_files = canonical.starting_files.map(normalizeFile);
  return createHash("sha256").update(JSON.stringify({ task, answer: canonical })).digest("hex");
}

export function scoreProviderAnswer(
  task: EvaluationTask, answer: ProviderAnswer, review?: AnswerReview | null,
): boolean {
  return (task.answerability === "unanswerable" || answer.answer_text.trim().length > 0) &&
    scoreProviderEvidence(task, answer) &&
    providerExpectationFailures(task, answer).length === 0 && review?.accepted === true &&
    review.answer_sha256 === answerReviewDigest(task, answer);
}

const reviewEntrySchema = answerReviewSchema.extend({
  task_id: z.string().min(1), variant: evaluationVariantSchema, repeat: z.number().int().positive(),
}).strict();

export function applyAnswerReviews(
  suite: Pick<EvaluationSuite, "tasks">, observationInputs: readonly unknown[], reviewInputs: readonly unknown[],
): EvaluationObservation[] {
  const observations = observationInputs.map((input) => evaluationObservationSchema.parse(input));
  const tasks = new Map(suite.tasks.map((task) => [task.id, task]));
  const keyFor = (item: { task_id: string; variant: string; repeat: number }) =>
    `${item.task_id}:${item.variant}:${item.repeat}`;
  const byKey = new Map(observations.map((item) => [keyFor(item), item]));
  if (byKey.size !== observations.length) throw new Error("Duplicate observation keys cannot be reviewed.");
  const seen = new Set<string>();
  for (const input of reviewInputs) {
    const { task_id, variant, repeat, ...review } = reviewEntrySchema.parse(input);
    const key = keyFor({ task_id, variant, repeat });
    if (seen.has(key)) throw new Error(`Duplicate answer review ${key}.`);
    seen.add(key);
    const observation = byKey.get(key);
    const task = tasks.get(task_id);
    if (observation === undefined || task === undefined) throw new Error(`Unknown answer review target ${key}.`);
    const answer = answerFromObservation(observation);
    if (review.answer_sha256 !== answerReviewDigest(task, answer)) {
      throw new Error(`Answer review ${key} does not match its task and answer.`);
    }
    observation.answer_review = review;
    observation.success = scoreProviderAnswer(task, answer, review);
  }
  return observations;
}

export function providerEvaluationPrompt(
  task: EvaluationTask,
  variant: EvaluationVariant,
  cliPath: string,
): string {
  const variantInstructions = variant === "codeatlas"
    ? [
        "Start with this repository-local CodeAtlas command and use its evidence before opening source files:",
        `node ${JSON.stringify(cliPath)} context ${JSON.stringify(task.prompt)} . --budget ${task.context_token_budget} --format json`,
        "You may use other read-only CodeAtlas commands when the first packet is insufficient.",
      ].join("\n")
    : "Do not run CodeAtlas. Use ordinary repository search and source-reading commands.";
  return [
    "Work read-only. Answer the repository question with source evidence.",
    variantInstructions,
    `Question: ${task.prompt}`,
    "Return only the requested structured result. List repository-relative evidence files, the files you inspected first, important concepts stated in the answer, and canonical relationship types you used. Abstain when the repository cannot support the answer.",
  ].join("\n\n");
}

export function providerVariantOrder(
  taskIndex: number,
  repeat: number,
): readonly EvaluationVariant[] {
  return (taskIndex + repeat) % 2 === 0
    ? ["native", "codeatlas"]
    : ["codeatlas", "native"];
}

export function evaluationSuiteSha256(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function transcriptSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
