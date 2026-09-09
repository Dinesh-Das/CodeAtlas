# CodeAtlas outcome evaluations

The development suite defines 30 tasks across six pinned, Apache-2.0 fixture repositories. It covers architecture explanation, change location, cross-file fixes, refactoring, affected tests, ambiguous questions, and questions outside the indexed source. An unsupported C# fixture uses unfamiliar Welsh identifiers to test whether an agent falls back to native source tools and reports the CodeAtlas coverage gap. These fixtures are public development data. They are not the held-out set and their results must not be presented as product efficacy claims.

Validate the suite, including deterministic content hashes:

```bash
npm run eval:validate
```

Run the paired provider harness with an exact model identifier and provider-reported version:

```bash
npm run eval:provider -- \
  --suite evals/development.json \
  --provider codex \
  --model <model-id> \
  --model-version <immutable-model-version> \
  --output-dir evals/runs/<run-id>

npm run eval:report -- \
  --suite evals/development.json \
  --run evals/runs/<run-id>/run.json \
  --observations evals/runs/<run-id>/observations.jsonl \
  --output evals/runs/<run-id>/report.json \
  --require-gate
```

The runner copies every pinned fixture into a fresh temporary Git repository for every task,
repeat, and variant. Native runs may use normal repository tools but are prohibited from running
CodeAtlas. CodeAtlas runs initialize the local index first and must begin with a budgeted `context`
packet. Both variants use the same read-only model, output schema, task, and cold-workspace policy.
Success is computed from required evidence recall, calibrated abstention, required concepts,
relationship types, allowed starting files, and forbidden distractors; the model does not grade
itself. Provider token events and tool calls are retained in the observation records.

Use `--dry-run` to validate the model metadata and observation count without making provider calls.
Run artifacts can contain model answers and file names; review them before publishing.

An experiment has two inputs in addition to the suite. The run manifest pins the exact provider, model ID and model version, harness ID and version, cache state, and repeat count. The observations file is JSON Lines with one result per task, variant, and repeat. Both `native` and `codeatlas` must run with the same run manifest and at least three repeats.

```json
{
  "schema_version": 1,
  "evaluator_version": "1.2.0",
  "id": "pilot-2026-09-06",
  "suite_id": "codeatlas-development-v1",
  "created_at": "2026-09-06T12:00:00.000+05:30",
  "model": {
    "provider": "provider-name",
    "id": "exact-model-id",
    "version": "immutable-model-version"
  },
  "harness": {
    "id": "agent-harness-name",
    "version": "immutable-harness-version"
  },
  "cache_state": "cold",
  "repeats": 3,
  "variants": ["native", "codeatlas"]
}
```

You can also generate a report from observations produced by another compatible harness:

```bash
npm run eval:report -- --suite evals/development.json --run path/to/run.json --observations path/to/observations.jsonl --output path/to/report.json
```

Use `--verify-fixtures` to reject fixture drift and `--require-gate` when the command should fail unless the predeclared launch gate passes. The development suite's primary outcome is median model-visible context tokens. The target is a 20% reduction with no more than a 2 percentage-point task-success regression.

Task answerability and CodeAtlas coverage are separate fields. An answerable task outside CodeAtlas coverage still expects the paired agent to answer from native source tools and disclose the limitation. The report aggregates repeats into one result per task before calculating success rates. It reports task-level Wilson intervals and repository-clustered bootstrap intervals for paired differences. It also reports required-file recall, calibrated abstention, extraction precision/recall by edge type and framework when supplied, explanation support/completeness when reviewed, patch regressions and unnecessary edits, knowledge-transfer timing/correctness, wall time, tool calls, tokens, and cost.

Provider transcripts are intentionally outside the result schema. Keep raw transcripts private, scrub secrets and repository source before sharing, and publish only the structured observations and reviewer scores.
