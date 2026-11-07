# Interview case study

Verified upgrades: 2026-11-05 and 2026-11-07. Scope: job-switch and interview readiness.

AI Engineer: code intelligence, evidence retrieval and honest agent evaluation.

## Architecture and engineering decision

The tool indexes repository symbols/relationships into canonical IR and SQLite, exposes bounded context through MCP, and compares agent runs through an evaluation harness.

Claimed success now requires source evidence for answerable tasks and calibrated abstention for unanswerable tasks. Extracted expected edges cannot exceed reported edges. Indexed search retains enriched evidence text and substring candidates, then uses the shared canonical ranker with stable tie ordering.

The 2026-11-07 scoring repair also requires actual answer text and independent review
bound to the task and structured answer. Evidence retrieval is a separate metric;
unreviewed runs stay incomplete. Read-only fix/refactoring fixtures evaluate answers
and change plans, not executed patches. The Windows provider launcher preserves argv
through Node or a native executable without a batch shell.

## Five-minute walkthrough

Show source-backed context for a code change and identify affected tests. Then feed the evaluator a claimed success without evidence: the run must be incomplete. Explain the distinction between context compression, search performance and agent task success.

After the repository's documented dependency setup, run these commands from its root. Use an activated Python environment where applicable; Maven offline mode requires cached dependencies.

```text
npm test
npm run typecheck
npm run lint
npm run eval:validate
npm run benchmark -- --output docs/evidence/2026-11-05/search-benchmark.json
```

## Recorded evidence

233 tests passed, with type checks, lint and build passing. The generated 10,000-line / 100-file smoke benchmark passed all three canonical ordering checks after the ranking repair. Cold indexing took 1.078 s; warm canonical search p50/p95 was 144.75/151.80 ms. These timings include freshness checks; retrieval p95 was 7 ms. Full artifact: docs/evidence/2026-11-05/search-benchmark.json.

The 2026-11-07 repairs passed 245 tests plus type checks, lint, build, pinned-fixture
validation, and provider dry-run. Offline probes verified Windows argv preservation
and the separate unreviewed/reviewed report paths. No real provider calls were made.

Behavioral regressions were reproduced before their fixes. Passing contract tests demonstrate the named behavior; they are not an AI accuracy rating.

## Defensible resume wording

> Built evidence-first code context tooling with evaluation gates that reject unsupported success and inconsistent extraction counts.

Use this wording only after you can reproduce and explain the implementation. Add measured numbers with their dataset and environment; never substitute synthetic results for real-user impact.

## Questions to prepare

How do you establish that an agent found enough evidence? When should an agent abstain? Does a smaller context imply better task success? How do indexed candidates preserve canonical ranking?

## Remaining evidence

Real paired provider task-success evidence remains absent; synthetic observations validate the harness. Generated-repository benchmarks do not establish real-repository or agent outcomes. Substring compatibility scans precomputed search text and hydration remains bounded to 10,000 candidates, with truncation reported. Scale and representative repository profiling remain necessary. Stable release evidence gates remain in force.
