import { describe, expect, it } from "vitest";
import type { EvaluationTask } from "../../src/evaluation/models.js";
import {
  evaluationSuiteSha256,
  providerAnswerSchema,
  providerEvaluationPrompt,
  providerVariantOrder,
  scoreProviderAnswer,
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

    expect(scoreProviderAnswer(task, answer)).toBe(true);
    expect(providerAnswerSchema.safeParse({ ...answer, success: true }).success).toBe(false);
  });

  it("binds suites and transcripts to deterministic SHA-256 digests", () => {
    expect(evaluationSuiteSha256({ id: "suite", tasks: [1, 2] })).toHaveLength(64);
    expect(transcriptSha256("event\n")).toBe(transcriptSha256("event\n"));
    expect(transcriptSha256("event\n")).not.toBe(transcriptSha256("changed\n"));
  });
});
