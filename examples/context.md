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

For a compact agent brief with deferred source:

```bash
codeatlas context "Refactor PaymentService" --budget 6000 --format compact --evidence references
```

MCP clients call `prepare_change` with `task`, `budget`, `format: "compact"`, and
`evidence: "references"`. Expand local aliases using the response dictionaries before passing
full IDs to `trace` or `get_evidence`. The legacy `get_change_context` remains available when
legacy tools are enabled. The result ranks source-backed change candidates, separates verified
and potential paths, includes relevant tests, contracts, rules, and architecture decisions, and
reports ambiguity or missing coverage as gaps. Smaller budgets can omit sections; follow the
continuation rather than interpreting an omitted test as proof that no test exists.

See the [format and measurement guide](../docs/compact-context.md).

The budget unit is `utf8_bytes_upper_bound`, measured by `utf8-bytes-upper-bound/v1`. Each UTF-8 byte consumes one unit, so the contract does not claim model-specific token accuracy. MCP requests reserve space for the canonical freshness, provenance, coverage, uncertainty, trust, error, and next-action envelope.

Repository excerpts are labeled `untrusted_repository_content`. Candidate locations and graph paths carry evidence IDs. Recommendations use `fact_class: "inference"` so consumers can keep suggested edits separate from extracted and resolved facts.
