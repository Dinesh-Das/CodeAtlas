import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVALUATION_HARNESS_VERSION,
  evaluationSuiteSchema,
  type EvaluationObservation,
  type EvaluationRun,
  type EvaluationSuite,
} from "../../src/evaluation/models.js";
import { evaluationSuiteSha256 } from "../../src/evaluation/provider.js";
import { evaluateRun } from "../../src/evaluation/runner.js";

function pairedFixture() {
  const development = evaluationSuiteSchema.parse(JSON.parse(readFileSync(
    new URL("../../evals/development.json", import.meta.url),
    "utf8",
  )));
  const answerable = development.tasks.find((task) =>
    task.answerability === "answerable" && task.expectations === undefined
  );
  const unanswerable = development.tasks.find((task) => task.answerability === "unanswerable");
  if (answerable === undefined || unanswerable === undefined) {
    throw new Error("Development fixtures must include answerable and unanswerable tasks.");
  }
  const suite: EvaluationSuite = {
    ...development,
    id: "evaluation-boundary-contract-v1",
    tasks: [structuredClone(answerable), structuredClone(unanswerable)],
  };
  const run: EvaluationRun = {
    schema_version: 1,
    evaluator_version: EVALUATION_HARNESS_VERSION,
    id: "synthetic-boundary-unit-test",
    suite_id: suite.id,
    suite_sha256: evaluationSuiteSha256(suite),
    created_at: "2026-11-05T12:00:00+05:30",
    model: { provider: "unit-test", id: "no-provider-call", version: "fixture-v1" },
    harness: { id: "unit-test", version: "fixture-v1" },
    cache_state: "cold",
    repeats: 3,
    variants: ["native", "codeatlas"],
  };
  const observations: EvaluationObservation[] = suite.tasks.flatMap((task) =>
    (["native", "codeatlas"] as const).flatMap((variant) =>
      [1, 2, 3].map((repeat) => ({
        schema_version: 1 as const,
        task_id: task.id,
        variant,
        repeat,
        success: true,
        abstained: task.answerability === "unanswerable",
        evidence_files: task.acceptable_evidence[0]?.files ?? [],
        metrics: {
          context_tokens: variant === "native" ? 500 : 300,
          input_tokens: 700,
          output_tokens: 50,
          duration_ms: 100,
          tool_calls: 1,
          cost_usd: null,
        },
        extraction: null,
        explanation: null,
        patch: null,
        knowledge_transfer: null,
      }))
    )
  );
  return { suite, run, observations, answerableId: answerable.id, unanswerableId: unanswerable.id };
}

describe("evaluation observation trust boundaries", () => {
  it("retains a complete valid paired run as a passing control", () => {
    const { suite, run, observations } = pairedFixture();

    const report = evaluateRun(suite, run, observations);

    expect(report.complete).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.launch_gate.status).toBe("passed");
    expect(report.variants.codeatlas.task_success_rate).toBe(1);
  });

  it("rejects claimed answerable success when required source evidence is absent", () => {
    const { suite, run, observations, answerableId } = pairedFixture();
    for (const observation of observations.filter((item) => item.task_id === answerableId)) {
      observation.evidence_files = [];
    }

    const report = evaluateRun(suite, run, observations);

    expect(report.complete).toBe(false);
    expect(report.launch_gate.status).toBe("incomplete");
  });

  it("rejects claimed unanswerable success without calibrated abstention", () => {
    const { suite, run, observations, unanswerableId } = pairedFixture();
    for (const observation of observations.filter((item) => item.task_id === unanswerableId)) {
      observation.abstained = false;
      observation.evidence_files = ["src/unrelated.ts"];
    }

    const report = evaluateRun(suite, run, observations);

    expect(report.complete).toBe(false);
    expect(report.launch_gate.status).toBe("incomplete");
  });

  it("rejects more found expected edges than the extractor reported", () => {
    const { suite, run, observations } = pairedFixture();
    observations[0]!.extraction = [{
      edge_type: "CALLS",
      framework: null,
      expected_edges: 1,
      found_expected_edges: 1,
      reported_edges: 0,
      verified_reported_edges: 0,
    }];

    const report = evaluateRun(suite, run, observations);

    expect(report.complete).toBe(false);
    expect(report.launch_gate.status).toBe("incomplete");
  });
});
