# Security Policy

## Reporting a vulnerability

Do not open a public issue containing exploit details, secrets, or private repository data.
Until a private disclosure address is published, contact the repository maintainers through a
private channel associated with the project host.

Include the affected version, operating system, reproduction steps, and impact. Remove all
real credentials and proprietary source from the report.

## Security model

CodeAtlas is local-first and performs no telemetry or source upload. It never indexes known
secret-file paths and never stores complete source files. Repository files, comments, and
documentation are untrusted input; source snippets exposed over MCP are always
labeled `untrusted_repository_content`.

`codeatlas build` writes local architecture artifacts that may include bounded source excerpts as
evidence. `codeatlas.html`, `.codeatlas/current/`, `.codeatlas/snapshots/`, and generated agent
context should be protected like the source repository and must not be published for a proprietary
codebase without review.

Core indexing, IR generation, HTML generation, snapshots, rules, review, and deterministic
`codeatlas ask` retrieval make no network request. No source is sent to an AI provider unless a
future optional provider is explicitly enabled and documented.

The source tool resolves indexed paths against the current repository root and rejects paths that
resolve outside it. Source responses are capped by `limits.maxSourceSnippetLines` and
`limits.maxSourceSnippetBytes`, including protection against a single oversized/minified line.

Every MCP packet identifies repository content as untrusted, declares that indexing is local-only,
and states that CodeAtlas returns evidence rather than invented answers. The MCP host or model may
send returned context to an external provider; that provider behavior is outside CodeAtlas and is
controlled by the user's MCP host configuration.

The index writer uses an exclusive repository-local lock. Structural, semantic, and search facts
advance atomically in one SQLite transaction. Architecture is computed outside that write lock and
published in a second atomic transaction carrying the structural generation it derives from. WAL
mode therefore lets readers see either the prior committed graph or a generation-labeled partial
state, never partially written rows; freshness gates require the generation appropriate to each
query and repair stale derived materialization when needed.

Framework adapters do not persist route or database-table string literal values. They retain
only cryptographic hashes alongside methods, structural identifiers, relationships, and source
evidence.

Documentation headings and intent-comment categories are indexed for architectural discovery.
Comment bodies are represented by hashes and source locations rather than copied into the graph;
the bounded source tool remains the explicit path for retrieving repository text.

Architecture history analysis never stores commit diffs or contributor identities. It persists
only bounded aggregate churn, commit/contributor counts, and the latest commit hash/date per file.

Users should still protect `.codeatlas/` with normal filesystem permissions. Although the
database is automatically ignored by Git, it contains repository names, paths, symbol metadata
and structural relationships.

When a compatible `typescript` package with the required compiler API is installed in the target
repository, CodeAtlas loads that compiler to honor the repository's own resolution semantics.
Analyze only repositories and installed dependencies you trust to execute locally; `codeatlas
doctor` reports whether the repository or bundled compiler is active and why fallback occurred.
