import { createHash } from "node:crypto";
import { z } from "zod";
import type { EvaluationTask, EvaluationVariant } from "./models.js";

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

function expectationPassed(task: EvaluationTask, answer: ProviderAnswer): boolean {
  const expectations = task.expectations;
  if (expectations === undefined) return true;
  const text = `${answer.answer_text}\n${answer.concepts.join("\n")}`.toLowerCase();
  const relationships = new Set(answer.relationship_types.map((item) => item.toUpperCase()));
  const starts = new Set(answer.starting_files.map(normalizeFile));
  return expectations.required_concepts.every((concept) => text.includes(concept.toLowerCase())) &&
    expectations.required_relationship_types.every((type) => relationships.has(type.toUpperCase())) &&
    (expectations.allowed_starting_files.length === 0 ||
      expectations.allowed_starting_files.some((file) => starts.has(normalizeFile(file)))) &&
    expectations.forbidden_distractors.every((value) => !text.includes(value.toLowerCase()));
}

export function scoreProviderAnswer(task: EvaluationTask, answer: ProviderAnswer): boolean {
  if (task.answerability === "unanswerable") {
    return answer.abstained && answer.evidence_files.length === 0;
  }
  return !answer.abstained && evidenceRecall(task, answer.evidence_files) === 1 &&
    expectationPassed(task, answer);
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
