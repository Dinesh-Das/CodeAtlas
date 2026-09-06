# Budgeted change context

Compile a human-readable implementation brief:

```bash
codeatlas context "Add rate limiting to login" --budget 6000 --format markdown
```

Compile JSON for an agent or script:

```bash
codeatlas context "Refactor PaymentService" --budget 6000 --format json
```

Prepare context for the working-tree difference from a Git base:

```bash
codeatlas context --diff HEAD --repository /absolute/path/to/repository --budget 6000 --format json
```

MCP clients can call `get_change_context` with `task` and `budget`. The result ranks source-backed change candidates, separates verified and potential paths, includes relevant tests, contracts, rules, and architecture decisions, and reports ambiguity or missing coverage as gaps.

The budget uses `utf8-bytes-upper-bound/v1`: each UTF-8 byte counts as one estimated token. This deliberately overestimates common model tokenizers. MCP requests reserve space for the canonical freshness, provenance, coverage, uncertainty, trust, error, and next-action envelope.

Repository excerpts are labeled `untrusted_repository_content`. Candidate locations and graph paths carry evidence IDs. Recommendations use `fact_class: "inference"` so consumers can keep suggested edits separate from extracted and resolved facts.
