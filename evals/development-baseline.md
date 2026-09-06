# Development evaluation baseline

Baseline date: 2026-09-06

The checked-in development baseline is the evaluation definition, not a model-performance claim:

- 6 content-pinned fixture repositories
- 30 tasks
- 6 task categories
- 1 unsupported-language repository with unfamiliar identifiers and explicit native-tool fallback expectations
- 3 paired repeats required, producing 180 observations for a complete run
- required-file retrieval scored against task-specific acceptable evidence sets
- explicit unanswerable and out-of-coverage tasks scored for calibrated abstention
- repository-clustered confidence intervals for paired changes
- predeclared primary outcome: at least 20% lower median context tokens
- allowed task-success regression: at most 2 percentage points

No comparative agent run is checked in yet. The launch gate therefore remains unassessed. A model result belongs here only after the run manifest names an immutable provider model version and harness version, fixture hashes pass, all paired observations are present, and any publishable transcript has been scrubbed.
