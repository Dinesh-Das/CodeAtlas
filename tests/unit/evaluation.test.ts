import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluationSuiteSchema,
  type EvaluationObservation,
  type EvaluationRun,
  type EvaluationSuite,
} from "../../src/evaluation/models.js";
import {
  evaluateRun,
  fixtureContentSha256,
  validatePinnedFixtures,
} from "../../src/evaluation/runner.js";

function suite(): EvaluationSuite {
  return {
    schema_version: 1,
    id: "evaluation-test-v1",
    title: "Evaluation test",
    visibility: "development",
    minimum_repeats: 3,
    repositories: [{
      id: "fixture-one",
      fixture_root: "fixture",
      content_sha256: "a".repeat(64),
      license: "Apache-2.0",
      languages: ["typescript"],
      negative_coverage: false,
    }],
    tasks: [
      {
        id: "answerable-task",
        repository_id: "fixture-one",
        category: "change_location",
        prompt: "Where is the requested behavior implemented?",
        answerability: "answerable",
        codeatlas_coverage: "supported",
        context_token_budget: 2_000,
        acceptable_evidence: [{ description: "Either implementation is accepted.", files: ["src/a.ts"] }],
        expected_behavior: "Find src/a.ts.",
        patch_test: null,
      },
      {
        id: "unanswerable-task",
        repository_id: "fixture-one",
        category: "unanswerable",
        prompt: "Which missing subsystem handles the request?",
        answerability: "unanswerable",
        codeatlas_coverage: "supported",
        context_token_budget: 2_000,
        acceptable_evidence: [],
        expected_behavior: "Abstain.",
        patch_test: null,
      },
    ],
    launch_gate: {
      primary_outcome: "context_tokens",
      minimum_relative_improvement: 0.2,
      maximum_task_success_regression: 0,
    },
  };
}

function run(): EvaluationRun {
  return {
    schema_version: 1,
    evaluator_version: "1.1.0",
    id: "evaluation-run-v1",
    suite_id: "evaluation-test-v1",
    created_at: "2026-09-06T12:00:00.000+05:30",
    model: { provider: "test", id: "fixed-model", version: "2026-09-06" },
    harness: { id: "test-harness", version: "1.0.0" },
    cache_state: "cold",
    repeats: 3,
    variants: ["native", "codeatlas"],
  };
}

function observation(
  taskId: string,
  variant: "native" | "codeatlas",
  repeat: number,
): EvaluationObservation {
  const answerable = taskId === "answerable-task";
  const codeAtlas = variant === "codeatlas";
  return {
    schema_version: 1,
    task_id: taskId,
    variant,
    repeat,
    success: answerable || codeAtlas,
    abstained: !answerable && codeAtlas,
    evidence_files: answerable ? ["src/a.ts"] : [],
    metrics: {
      context_tokens: codeAtlas ? 600 : 1_000,
      input_tokens: codeAtlas ? 800 : 1_200,
      output_tokens: 100,
      duration_ms: codeAtlas ? 700 : 1_000,
      tool_calls: codeAtlas ? 2 : 3,
      cost_usd: codeAtlas ? 0.01 : 0.02,
    },
    extraction: null,
    explanation: { support: codeAtlas ? 1 : 0.8, completeness: 1, independently_reviewed: true },
    patch: null,
    knowledge_transfer: null,
  };
}

function completeObservations(): EvaluationObservation[] {
  return suite().tasks.flatMap((task) =>
    (["native", "codeatlas"] as const).flatMap((variant) =>
      [1, 2, 3].map((repeat) => observation(task.id, variant, repeat))
    )
  );
}

describe("outcome evaluation runner", () => {
  it("aggregates paired repeats at task level and evaluates the predeclared gate", () => {
    const report = evaluateRun(suite(), run(), completeObservations());

    expect(report.complete).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.counts).toEqual({ repositories: 1, tasks: 2, repeats: 3, observations: 12 });
    expect(report.variants.native).toMatchObject({
      successful_tasks: 1,
      task_count: 2,
      task_success_rate: 0.5,
      mean_required_file_recall: 1,
      calibrated_abstention_rate: 0.5,
    });
    expect(report.variants.codeatlas).toMatchObject({
      successful_tasks: 2,
      task_success_rate: 1,
      mean_required_file_recall: 1,
      calibrated_abstention_rate: 1,
    });
    expect(report.paired).toMatchObject({
      success_rate_delta: 0.5,
      context_token_reduction: 0.4,
      duration_reduction: 0.3,
    });
    expect(report.launch_gate.status).toBe("passed");
  });

  it("marks a run incomplete when a paired repeat is absent", () => {
    const observations = completeObservations();
    observations.pop();
    const report = evaluateRun(suite(), run(), observations);

    expect(report.complete).toBe(false);
    expect(report.launch_gate.status).toBe("incomplete");
    expect(report.errors).toContain("Missing observation unanswerable-task:codeatlas:3.");
  });

  it("rejects answerable tasks without expected evidence", () => {
    const input = suite();
    input.tasks[0]!.acceptable_evidence = [];
    const parsed = evaluationSuiteSchema.safeParse(input);
    expect(parsed.success).toBe(false);
  });

  it("rejects claimed success when semantic task expectations are missed", () => {
    const input = suite();
    input.tasks[0]!.expectations = {
      required_concepts: ["authenticate"],
      required_relationship_types: ["CALLS"],
      allowed_starting_files: ["src/a.ts"],
      forbidden_distractors: ["unrelatedVariable"],
    };
    const observations = completeObservations();
    for (const item of observations.filter((candidate) => candidate.task_id === "answerable-task")) {
      item.answer_text = "The unrelatedVariable contains the implementation.";
      item.concepts = ["unrelatedVariable"];
      item.relationship_types = [];
      item.starting_files = ["src/other.ts"];
    }

    const report = evaluateRun(input, run(), observations);

    expect(report.complete).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("misses required concepts: authenticate"),
      expect.stringContaining("required relationship types: CALLS"),
      expect.stringContaining("allowed starting file: src/a.ts"),
      expect.stringContaining("forbidden distractors present: unrelatedVariable"),
    ]));
    expect(report.variants.codeatlas).toMatchObject({
      expectation_tasks_measured: 1,
      expectation_pass_rate: 0,
    });
  });

  it("hashes fixture contents deterministically and reports drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codeatlas-evaluation-"));
    try {
      const fixtureRoot = path.join(root, "fixture");
      await mkdir(fixtureRoot);
      await writeFile(path.join(fixtureRoot, "input.ts"), "export const value = 1;\n", "utf8");
      const digest = await fixtureContentSha256(fixtureRoot);
      const pinned = suite();
      pinned.repositories[0]!.content_sha256 = digest;
      pinned.tasks[0]!.acceptable_evidence[0]!.files = ["input.ts"];

      expect(await validatePinnedFixtures(pinned, root)).toEqual([]);
      await writeFile(path.join(fixtureRoot, "input.ts"), "export const value = 2;\n", "utf8");
      expect(await validatePinnedFixtures(pinned, root)).toEqual([
        expect.stringContaining("does not match"),
      ]);

      pinned.tasks[0]!.acceptable_evidence[0]!.files = ["../outside.ts"];
      expect(await validatePinnedFixtures(pinned, root)).toEqual(
        expect.arrayContaining([expect.stringContaining("escapes its fixture root")]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
