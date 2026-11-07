import { describe, expect, it } from "vitest";
import type { EvaluationTask } from "../../src/evaluation/models.js";
import {
  evaluationSuiteSha256,
  providerAnswerSchema,
  providerEvaluationPrompt,
  providerVariantOrder,
  scoreProviderAnswer,
  scoreProviderEvidence,
  answerReviewDigest,
  applyAnswerReviews,
  transcriptSha256,
} from "../../src/evaluation/provider.js";

const task: EvaluationTask = {
  id: "blind-provider-task",
  repository_id: "fixture-one",
  category: "architecture_explanation",
  prompt: "Explain how requests reach the authentication service.",
  answerability: "answerable",
  codeatlas_coverage: "supported",
  context_token_budget: 900,
  acceptable_evidence: [{ description: "Request path", files: ["src/app.ts", "src/auth.ts"] }],
  expectations: {
    required_concepts: ["authenticate"],
    required_relationship_types: ["CALLS"],
    allowed_starting_files: ["src/app.ts"],
    forbidden_distractors: ["duplicate"],
  },
  expected_behavior: "SECRET RUBRIC: name both implementation files.",
  patch_test: null,
};

describe("provider evaluation protocol", () => {
  it("keeps the grading rubric out of both agent prompts", () => {
    for (const variant of ["native", "codeatlas"] as const) {
      const prompt = providerEvaluationPrompt(task, variant, "/tool/codeatlas.js");
      expect(prompt).toContain(task.prompt);
      expect(prompt).not.toContain(task.expected_behavior);
      expect(prompt).not.toContain("grading");
    }
  });

  it("counterbalances which paired variant runs first", () => {
    expect(providerVariantOrder(0, 1)).toEqual(["codeatlas", "native"]);
    expect(providerVariantOrder(0, 2)).toEqual(["native", "codeatlas"]);
    expect(providerVariantOrder(1, 1)).toEqual(["native", "codeatlas"]);
  });

  it("validates and deterministically scores structured answers", () => {
    const answer = providerAnswerSchema.parse({
      answer_text: "src/app.ts calls authenticate.",
      abstained: false,
      evidence_files: ["src/app.ts", "src/auth.ts"],
      concepts: ["authenticate"],
      relationship_types: ["CALLS"],
      starting_files: ["./src/app.ts"],
    });

    expect(scoreProviderAnswer(task, answer, {
      reviewer: "synthetic-unit-test", accepted: true, answer_sha256: answerReviewDigest(task, answer),
    })).toBe(true);
    expect(providerAnswerSchema.safeParse({ ...answer, success: true }).success).toBe(false);
  });

  it("rejects empty answers even when all expected metadata and evidence are supplied", () => {
    const answer = {
      answer_text: " \n ", abstained: false, evidence_files: ["src/app.ts", "src/auth.ts"],
      concepts: ["authenticate"], relationship_types: ["CALLS"], starting_files: ["src/app.ts"],
    };
    expect(scoreProviderAnswer(task, answer, {
      reviewer: "synthetic-unit-test", accepted: true, answer_sha256: answerReviewDigest(task, answer),
    })).toBe(false);
    const withoutExpectations = { ...task, expectations: undefined };
    expect(scoreProviderAnswer(withoutExpectations, answer, {
      reviewer: "synthetic-unit-test", accepted: true, answer_sha256: answerReviewDigest(withoutExpectations, answer),
    })).toBe(false);
  });

  it("does not count metadata concepts as a substantive answer", () => {
    const answer = {
      answer_text: "The files contain some code.", abstained: false,
      evidence_files: ["src/app.ts", "src/auth.ts"], concepts: ["authenticate"],
      relationship_types: ["CALLS"], starting_files: ["src/app.ts"],
    };
    expect(scoreProviderAnswer(task, answer, {
      reviewer: "synthetic-unit-test", accepted: true, answer_sha256: answerReviewDigest(task, answer),
    })).toBe(false);
    expect(scoreProviderEvidence(task, answer)).toBe(true);
  });

  it("rejects a stale review after the answer or task rubric changes", () => {
    const answer = {
      answer_text: "src/app.ts calls authenticate.", abstained: false,
      evidence_files: ["src/app.ts", "src/auth.ts"], concepts: ["authenticate"],
      relationship_types: ["CALLS"], starting_files: ["src/app.ts"],
    };
    const review = { reviewer: "synthetic-unit-test", accepted: true, answer_sha256: answerReviewDigest(task, answer) };
    expect(scoreProviderAnswer(task, { ...answer, answer_text: "authenticate does nothing." }, review)).toBe(false);
    expect(scoreProviderAnswer({ ...task, expected_behavior: "Different independent rubric" }, answer, review)).toBe(false);
  });

  it("keeps review digests stable when the runner normalizes Windows evidence paths", () => {
    const answer = {
      answer_text: "src/app.ts calls authenticate in src/auth.ts.", abstained: false,
      evidence_files: [".\\src\\app.ts", "src\\auth.ts"], concepts: ["authenticate"],
      relationship_types: ["CALLS"], starting_files: [".\\src\\app.ts"],
    };
    const stored = { ...answer, evidence_files: ["src/app.ts", "src/auth.ts"], starting_files: ["src/app.ts"] };
    expect(answerReviewDigest(task, answer)).toBe(answerReviewDigest(task, stored));
    expect(scoreProviderAnswer(task, stored, { reviewer: "synthetic-unit-test", accepted: true,
      answer_sha256: answerReviewDigest(task, answer) })).toBe(true);
  });

  it("keeps evidence retrieval separate from independently reviewed answer success", () => {
    const answer = {
      answer_text: "src/app.ts calls authenticate in src/auth.ts.", abstained: false,
      evidence_files: ["src/app.ts", "src/auth.ts"], concepts: ["authenticate"],
      relationship_types: ["CALLS"], starting_files: ["src/app.ts"],
    };
    expect(scoreProviderAnswer(task, answer)).toBe(false);
  });

  it("accepts reviewed empty abstentions unless the task explicitly requires an explanation", () => {
    const unanswerable: EvaluationTask = { ...task, answerability: "unanswerable", acceptable_evidence: [] };
    delete unanswerable.expectations;
    const answer = { answer_text: "", abstained: true, evidence_files: [], concepts: [],
      relationship_types: [], starting_files: [] };
    expect(scoreProviderAnswer(unanswerable, answer, {
      reviewer: "synthetic-unit-test", accepted: true, answer_sha256: answerReviewDigest(unanswerable, answer),
    })).toBe(true);

    const explanatory: EvaluationTask = { ...unanswerable, expectations: {
      required_concepts: ["insufficient evidence"], required_relationship_types: [],
      allowed_starting_files: [], forbidden_distractors: [],
    } };
    expect(scoreProviderAnswer(explanatory, answer, {
      reviewer: "synthetic-unit-test", accepted: true, answer_sha256: answerReviewDigest(explanatory, answer),
    })).toBe(false);
  });

  it("binds suites and transcripts to deterministic SHA-256 digests", () => {
    expect(evaluationSuiteSha256({ id: "suite", tasks: [1, 2] })).toHaveLength(64);
    expect(transcriptSha256("event\n")).toBe(transcriptSha256("event\n"));
    expect(transcriptSha256("event\n")).not.toBe(transcriptSha256("changed\n"));
  });

  it("applies independent review files without accepting duplicates, unknown targets, or stale answers", () => {
    const answer = {
      answer_text: "src/app.ts calls authenticate in src/auth.ts.", abstained: false,
      evidence_files: ["src/app.ts", "src/auth.ts"], concepts: ["authenticate"],
      relationship_types: ["CALLS"], starting_files: ["src/app.ts"],
    };
    const observation = {
      schema_version: 1, task_id: task.id, variant: "native", repeat: 1, success: false, ...answer,
      metrics: { context_tokens: 100, input_tokens: 100, output_tokens: 20, duration_ms: 10,
        tool_calls: 1, cost_usd: null },
      extraction: null, explanation: null, patch: null, knowledge_transfer: null,
    };
    const review = { task_id: task.id, variant: "native", repeat: 1, reviewer: "synthetic-unit-test",
      accepted: true, answer_sha256: answerReviewDigest(task, answer) };
    const suite = { tasks: [task] };

    expect(applyAnswerReviews(suite, [observation], [review])[0]!.success).toBe(true);
    expect(observation.success).toBe(false);
    expect(applyAnswerReviews(suite, [observation], [{ ...review, accepted: false }])[0]!.success).toBe(false);
    expect(() => applyAnswerReviews(suite, [observation], [review, review])).toThrow(/Duplicate/u);
    expect(() => applyAnswerReviews(suite, [observation], [{ ...review, repeat: 2 }])).toThrow(/Unknown/u);
    expect(() => applyAnswerReviews(suite, [observation], [{ ...review, answer_sha256: "0".repeat(64) }]))
      .toThrow(/does not match/u);
    expect(() => applyAnswerReviews(suite, [observation], [{ ...review, accepted: null, reviewer: "" }])).toThrow();
    expect(providerAnswerSchema.safeParse({ ...answer, answer_review: review }).success).toBe(false);
  });
});
