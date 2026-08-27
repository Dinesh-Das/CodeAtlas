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

The source tool resolves indexed paths against the current repository root and rejects paths that
resolve outside it. Source responses are capped by `limits.maxSourceSnippetLines` and
`limits.maxSourceSnippetBytes`, including protection against a single oversized/minified line.

Every MCP packet identifies repository content as untrusted, declares that indexing is local-only,
and states that CodeAtlas returns evidence rather than invented answers. The MCP host or model may
send returned context to an external provider; that provider behavior is outside CodeAtlas and is
controlled by the user's MCP host configuration.

The index writer uses an exclusive repository-local lock and a single SQLite transaction. WAL
mode permits readers to see a prior committed graph rather than partially written state.

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
