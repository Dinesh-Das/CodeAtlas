# CodeAtlas outcome evaluations

The development suite defines 30 tasks across six pinned, Apache-2.0 fixture repositories. It covers architecture explanation, change location, cross-file fixes, refactoring, affected tests, ambiguous questions, and questions outside the indexed source. An unsupported Rust fixture uses unfamiliar Welsh identifiers to test whether an agent falls back to native source tools and reports the CodeAtlas coverage gap. These fixtures are public development data. They are not the held-out set and their results must not be presented as product efficacy claims.

Validate the suite, including deterministic content hashes:

```bash
npm run eval:validate
```

An experiment has two inputs in addition to the suite. The run manifest pins the exact provider, model ID and model version, harness ID and version, cache state, and repeat count. The observations file is JSON Lines with one result per task, variant, and repeat. Both `native` and `codeatlas` must run with the same run manifest and at least three repeats.

```json
{
  "schema_version": 1,
  "evaluator_version": "1.0.0",
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

Generate a report after recording the observations:

```bash
npm run eval:report -- --suite evals/development.json --run path/to/run.json --observations path/to/observations.jsonl --output path/to/report.json
```

Use `--verify-fixtures` to reject fixture drift and `--require-gate` when the command should fail unless the predeclared launch gate passes. The development suite's primary outcome is median model-visible context tokens. The target is a 20% reduction with no more than a 2 percentage-point task-success regression.

Task answerability and CodeAtlas coverage are separate fields. An answerable task outside CodeAtlas coverage still expects the paired agent to answer from native source tools and disclose the limitation. The report aggregates repeats into one result per task before calculating success rates. It reports task-level Wilson intervals and repository-clustered bootstrap intervals for paired differences. It also reports required-file recall, calibrated abstention, extraction precision/recall by edge type and framework when supplied, explanation support/completeness when reviewed, patch regressions and unnecessary edits, knowledge-transfer timing/correctness, wall time, tool calls, tokens, and cost.

Provider transcripts are intentionally outside the result schema. Keep raw transcripts private, scrub secrets and repository source before sharing, and publish only the structured observations and reviewer scores.
