# CodeAtlas outcome evaluations

The development suite defines 30 tasks across six pinned, Apache-2.0 fixture repositories. It covers architecture explanation, change location, cross-file change plans, refactoring plans, affected tests, ambiguous questions, and questions outside the indexed source. These are read-only repository-answer tasks: the fix/refactoring category names do not mean a patch was executed or validated. An unsupported C# fixture uses unfamiliar Welsh identifiers to test whether an agent falls back to native source tools and reports the CodeAtlas coverage gap. These fixtures are public development data. They are not the held-out set and their results must not be presented as product efficacy claims.

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

# Complete the independent review file described below before reporting.
npm run eval:report -- \
  --suite evals/development.json \
  --run evals/runs/<run-id>/run.json \
  --observations evals/runs/<run-id>/observations.jsonl \
  --reviews evals/runs/<run-id>/reviews.jsonl \
  --output evals/runs/<run-id>/report.json \
  --require-gate
```

The runner copies every pinned fixture into a fresh temporary Git repository for every task,
repeat, and variant. Native runs may use normal repository tools but are prohibited from running
CodeAtlas. CodeAtlas runs initialize the local index first and must begin with a budgeted `context`
packet. Both variants use the same read-only model, output schema, task, and cold-workspace policy.
The runner never sends `expected_behavior` or other rubric fields to the model, alternates which
variant runs first, and includes CodeAtlas initialization in its duration. Automatic evidence
retrieval success checks required files and abstention; it is reported separately from reviewed
answer success. An answerable response must contain nonblank text, satisfy task expectations,
and receive an independent accepted review before it can count as successful. A reviewed
unanswerable response may be empty when it abstains without evidence and the task does not
explicitly require explanatory concepts. Required concepts must appear in
the actual answer text; a list of metadata concepts cannot substitute for the answer.

The runner writes `reviews.pending.jsonl` with each task/variant/repeat and its task-and-answer
digest. Copy it to `reviews.jsonl`. An independent reviewer checks the actual answer and source
evidence against `expected_behavior` and any explicit expectations, fills `reviewer`, and sets
`accepted` to true or false for every observation. Accept only a correct, complete, source-backed
answer or a justified refusal. Pass that file using `--reviews`; the report command computes the
success field itself. Empty reviewer names, null decisions, duplicate/unknown targets, and stale
digests are rejected. The digest binds the task rubric and all structured answer fields, so edited
answers or tasks require a fresh review. Raw provider responses cannot supply review fields.

Without reviews, reports still show evidence measurements but remain incomplete and cannot pass
the answer-success launch gate. `outcome_scope` is `reviewed_repository_answer`: this is neither
automatically judged correctness nor proof of an executed code fix. Reviewer attribution records
the external review workflow; it does not authenticate the reviewer. Keep that provenance with
the private transcripts. Evaluator 1.4.0 requires this review contract; regenerate or review older
observations instead of relabeling old task-success scores.

Every successful provider call writes its raw JSONL event stream below the private run directory's
`transcripts/` folder. `transcripts/manifest.json` binds each transcript and prompt to SHA-256
digests. These files may contain source excerpts or tool output: retain them for independent review,
but scrub them before any publication. Structured observations contain only answer and aggregate
usage fields.

Use `--dry-run` to validate the model metadata and observation count without making provider calls.
Run artifacts can contain model answers and file names; review them before publishing.

On Windows the runner launches the installed npm package's JavaScript entry point
with Node, or a native `codex.exe`; it never sends prompts through a batch shell.
For a nonstandard installation, pass `--codex-cli-js <path-to-codex.js>` (or set
`CODEX_CLI_JS`). Paths containing spaces and prompt punctuation remain separate
process arguments. The launcher tests use offline fixtures and make no provider calls.

An experiment has a run manifest, raw observations, and independent reviews in addition to the suite. The run manifest pins the exact provider, model ID and model version, harness ID and version, cache state, and repeat count. The observations file is JSON Lines with one result per task, variant, and repeat. Both `native` and `codeatlas` must run with the same run manifest and at least three repeats.

```json
{
  "schema_version": 1,
  "evaluator_version": "1.4.0",
  "id": "pilot-2026-09-06",
  "suite_id": "codeatlas-development-v1",
  "suite_sha256": "sha256-of-the-parsed-suite",
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
npm run eval:report -- --suite evals/development.json --run path/to/run.json --observations path/to/observations.jsonl --reviews path/to/reviews.jsonl --output path/to/report.json
```

Use `--verify-fixtures` to reject fixture drift and `--require-gate` when the command should fail unless the predeclared launch gate passes. The development suite's primary outcome is median model-visible context tokens. The target is a 20% reduction with no more than a 2 percentage-point task-success regression.

Task answerability and CodeAtlas coverage are separate fields. An answerable task outside CodeAtlas coverage still expects the paired agent to answer from native source tools and disclose the limitation. The report aggregates repeats into one result per task before calculating success rates. It reports task-level Wilson intervals and repository-clustered bootstrap intervals for paired differences. It also reports required-file recall, calibrated abstention, extraction precision/recall by edge type and framework when supplied, explanation support/completeness when reviewed, patch regressions and unnecessary edits, knowledge-transfer timing/correctness, wall time, tool calls, tokens, and cost.

Provider transcripts are intentionally outside the result schema. Keep raw transcripts private, scrub secrets and repository source before sharing, and publish only the structured observations and reviewer scores.
