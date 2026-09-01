# Changelog

All notable changes follow semantic versioning.

## Unreleased

### Added

- Added the versioned canonical CodeAtlas IR with deterministic JSON/JSONL exports and first-class
  source evidence.
- Added `build`, `update`, `watch`, `diff`, `check`, `review`, `ask`, search/symbol/impact, and
  snapshot commands.
- Added a self-contained offline architecture application with bounded multi-level projections,
  full-graph search, execution flows, function CFGs, impact, Git changes, rules, and review views.
- Added explicit `.codeatlas.yml` domains and reusable architecture rules with CI failure semantics.
- Added persistent architecture snapshots, deterministic comparisons, Git hunk-to-symbol mapping,
  evidence-gated review findings, and canonical-IR MCP tools.
- Added interactive/exportable SVG architecture, sequence, and control-flow diagrams plus Mermaid
  architecture export, compressed offline HTML, scope-aware entrypoints/search, and a public
  language/framework extension API.
- Added configurable snapshot retention and pruning, coverage and lint gates, dependency auditing,
  CodeQL analysis, and private vulnerability reporting.
- Added a machine-enforced stable-release evidence manifest, independent repository/OS/language
  requirements, explicit scale budgets, tag-time multi-OS validation, pinned CI actions, and npm
  provenance enforcement.
- Added an isolated external-repository validator that installs the exact packed artifact and emits
  commit-, version-, timestamp-, and atlas-hash-bound evidence for the stable-release manifest.
- Added a pinned, least-privilege manual GitHub workflow for collecting those validation records on
  Linux, macOS, and Windows without executing the target repository's dependency scripts.
- Raised repository-wide coverage floors to 84% statements, 71% branches, 84% functions, and 86%
  lines after validating the higher thresholds against the complete suite.

### Fixed

- Added an evidence-backed starting-point fallback for generic AI-agent architecture questions on
  small repositories instead of returning an empty answer when no query term matches a symbol.
- Separated recoverable parser diagnostics from hard indexing failures and bounded external
  validation heaps within the stable-release memory budget.
- Canonicalized temporary repository fixtures and explicit modification timestamps so macOS path
  aliases/coarse timestamps and Windows 8.3 paths cannot cause false cross-platform CI failures.
- Prevented evidence and untracked-diff readers from following repository symlinks or junctions to
  files outside the repository root.
- Replaced stale-file lock cleanup with a crash-safe SQLite exclusive lock, eliminating the race
  that could admit concurrent index writers.
- Split rule and violation pagination into independent cursor scopes, bounded canonical-IR pages
  by serialized size, and made snapshot retrieval section-based instead of returning whole files.
- Added strict integer validation for CLI polling, search, and impact limits.
- Preserved independent branches in execution and impact paths, prevented converging branches from
  being labeled as cycles, and separated definite impact from heuristic or inferred potential impact.
- Reduced the default MCP surface from 33 overlapping tools to 19 canonical tools while retaining
  the legacy API behind `CODEATLAS_MCP_LEGACY_TOOLS=1`.
- Cached TypeScript compiler path normalization and indexed source-file lookup, eliminating repeated
  filesystem canonicalization and cutting the measured self-index candidate phase by roughly 96%.
- Made architecture scope and `doctor` diagnostics distinguish production code from tooling and
  repository metadata, so actionable warnings no longer count benchmark scripts or license files.
- Treated the supported bundled semantic compiler as healthy when a target compiler intentionally
  exposes no compiler API, while retaining warnings for unsupported versions and load failures.

## 0.10.0-beta.3 - 2026-08-29

### Fixed

- Synchronized the npm package version and installed CLI version after the `0.10.0-beta.2`
  artifact incorrectly reported `0.10.0-beta.1` from `codeatlas --version`.
- Added prominent npm, source, release, changelog, issue, CI, runtime, and license links that render
  consistently on both GitHub and npm.
- Completed npm author and discovery metadata and aligned it with the public GitHub repository.

## 0.10.0-beta.2 - 2026-08-29

### Known issue

- The published package metadata identifies this release as `0.10.0-beta.2`, but the installed
  CLI reports `0.10.0-beta.1`. Use `0.10.0-beta.3` or newer after it is published.

## 0.10.0-beta.1 - 2026-08-28

### Added

- Verified Fastify framework composition for decorators, implementations, plugin mounts,
  registration hooks, route protection, conditional hook continuation, and hashed route prefixes. Exact base
  and effective prefixed route literals are recovered transiently for MCP answers without storing
  plaintext route paths.
- Verified Prisma client `QUERIES` and `UPDATES` relationships from deterministic
  `prisma.<model>.<operation>` calls to parsed schema model nodes.
- Compiler-aware TypeScript/JavaScript public API fingerprints for inferred function returns,
  inferred exported values/objects, and JSDoc types.
- `codeatlas overview` for an immediate architecture summary and `codeatlas setup` for Codex,
  Claude Code, Cursor, and Antigravity MCP configuration.
- Persisted lifecycle ownership for extracted, resolver-generated, framework-projection,
  architecture-projection, and rename-history edges, with deterministic edit/revert parity and
  line-location reconciliation tests.
- Nested/inline Fastify plugin receivers and handlers, `preValidation`, inherited hook/prefix
  composition, and inline handler graph nodes.
- Endpoint labels and bounded evidence snippets on graph packets, truthful authoritative versus
  watched-cache freshness metadata, and database-backed dependency/feature pagination beyond the
  per-response result cap.

- TypeScript compiler-backed module and receiver-aware call resolution, workspace package nodes,
  internal package dependencies, package exports, aliases, and project configuration support.
- Generated 10k-to-1M+ LOC benchmark profiles with index phase timings, incremental edits,
  p50/p95/p99 queries and freshness checks, externally sampled peak RSS, and database growth;
  detached-worktree real-repository benchmarks cover implementation/export/shared-package edits,
  5/10-file changes, rename, and deletion without modifying the source checkout.
- Structural, semantic, search, and architecture generations, phase-level progress/telemetry,
  categorized import/parser/relationship diagnostics, SQLite object-size reporting, Fastify route
  extraction, and an event-invalidated fast-status cache with 30-second reconciliation.
- Regression coverage for 20,000-node dependency cycles, 10,000 independent SCCs,
  connected-graph clustering, layered business features, exact duplicate-method declarations,
  500 candidate methods, workspace wildcard exports, nested non-workspaces, generation crashes,
  invalidation truncation, natural questions, and balanced overview pagination.

### Changed

- `codeatlas init` now uses Git's local `info/exclude` by default; changing the tracked
  `.gitignore` requires `--shared-ignore`.
- `codeatlas init` now renders the same phase progress as `codeatlas index`; live index locks wait
  for up to 60 seconds, and `codeatlas setup --all` reports unavailable or failed clients while
  continuing with the remaining targets.
- Prerelease tags publish to their npm prerelease dist-tag rather than accidentally becoming
  `latest`.
- TypeScript semantic analysis prefers a compatible compiler installed by the target repository,
  falls back to the bundled compiler, and reports the exact choice in `codeatlas doctor`.
- Comment/format-only exported-file edits reuse compiler API fingerprints, framework composition
  rematerializes only after relevant semantic changes, and trace path budgets are spent using
  execution-semantic priority before result ranking.
- Tree-sitter input buffers now scale with source size, so files larger than 32 KiB are parsed
  normally instead of falling back to generic file metadata.
- Fastify hook flow now uses conditional `MAY_CONTINUE_TO` relationships rather than claiming that
  a hook must continue to a route handler.
- Prisma operations resolve database models by `metadata.client_accessor`, including lower-case
  schema model names, instead of guessed capitalization.

- Replaced all-pairs import-distance precomputation with bounded on-demand traversal and indexed
  symbol candidate generation.
- Replaced connected components with deterministic multilevel Louvain modularity optimization and
  recursive Tarjan traversal with an explicit-stack implementation plus single-pass SCC edge
  bucketing.
- MCP freshness uses Git/index/dirty-file signatures and a watched process cache rather than full
  repository discovery; concurrent refreshes are coalesced and generation requirements are
  tool-specific.
- Search uses normalized developer intent and SQL-backed page retrieval instead of paginating a
  permanently truncated in-memory candidate set.
- Architecture computation occurs outside the SQLite write transaction; generation-linked
  persistence remains atomic and crash-repairable. Schema 10 includes semantic-delta and source
  location state, resolution and dependency-community indexes, explicit edge ownership, and a
  rowid-addressed external-content FTS index with transactional bulk rebuilds; the indexing
  contract is `edge-ownership-13`.
- Tiny incremental updates fetch semantic records only for changed, deleted, renamed, or actually
  invalidated files; resolved-edge deletion is set-based, unresolved-import wakeup is grouped and
  hash-indexed, and workspace matching uses standards-complete brace/extglob/globstar semantics.
- The supported runtime is Node.js 22.12 or newer, matching the strictest runtime dependency; CI
  validates Node.js 22.12 and 24, and packed consumer smoke tests run on Linux, macOS, and Windows.

## 0.9.0 - 2026-08-27

### Added

- First-class `verified`, `inferred`, `dynamic`, `documentation`, `git`, and `unresolved`
  provenance categories on graph nodes, edges, and MCP relationships.
- Explicit callback, event, queue, dependency-injection, runtime-registration, reflection,
  polymorphic-candidate, and generated-code analysis with reduced confidence or unresolved
  diagnostics whenever a target cannot be proven.
- Weighted multi-signal feature inference using directories, symbols, routes, tests, imports,
  models, and dependency communities, plus strict configuration-based membership overrides.
- Architectural-intent nodes for README/ADR/document headings, intent-bearing comments, and test
  files, kept distinct from deterministic code and Git-history facts.
- Public framework-adapter registration with duplicate validation and per-file failure isolation;
  failed optional adapters now retain generic AST results.
- Relevance ranking across query similarity, feature membership, graph distance, symbol type,
  dependency strength, and confidence.
- Doctor diagnostics for unsupported languages, unresolved imports, dynamic relationships,
  indexing failures, stale state, graph integrity, and framework coverage gaps.
- Gap regression coverage for dynamic relationships, provenance, generated code, feature
  overrides, architectural intent, staged-only freshness, and adapter failure fallback.

### Changed

- Freshness fingerprints now include Git index entries in addition to HEAD, tracked working-tree
  hashes, and untracked hashes, detecting staged-only differences even when the working file
  matches its previously indexed content.
- File size and modification/change timestamps allow unchanged content hashes to be reused while
  preserving hash verification for filesystem changes, hidden working-tree modifications, and all
  Git state transitions.
- Dependency invalidation is bounded by both depth and file count; graph SQL queries are bounded
  before materialization and source snippets are capped by lines and UTF-8 bytes.
- MCP packets declare local-only indexing, untrusted repository content, evidence-only answers,
  and the boundary between CodeAtlas and external LLM behavior.
- The graph schema is now version 4 and the indexing contract is `evidence-7`.

## 0.8.0 - 2026-08-27

### Added

- Final Phase 8 npm packaging under `@dinesh-das/codeatlas`, preserving the `codeatlas` binary.
- Clean reproducible builds that remove stale compiler output before creating release artifacts.
- A tarball smoke test that packs, installs, invokes, initializes, and queries CodeAtlas in a
  disposable external Git repository.
- Three-platform CI across Linux, macOS, and Windows plus a package smoke-test gate.
- A tag-driven npm trusted-publishing workflow with OIDC and release version validation.
- Copyable MCP configuration, first-time installation guidance, release instructions, and an MCP
  tool reference for external developers.

### Changed

- The initialization summary now ends with `CodeAtlas is ready` and points users to both status
  and MCP commands.
- The npm package contains only compiled runtime files, public documentation, licensing, security,
  release guidance, and examples; source tests and stale build artifacts are excluded.
- CodeAtlas is version `0.8.0`; the graph schema remains version 3 and the indexing contract
  remains `architecture-6`.

## 0.7.0 - 2026-08-27

### Added

- Graph-backed implementations for `codeatlas_status`, `codeatlas_search`,
  `codeatlas_get_node`, `codeatlas_explain_feature`, `codeatlas_trace`, `codeatlas_impact`,
  `codeatlas_dependencies`, and `codeatlas_source`.
- Deterministic bounded graph traversal with explicit direct/transitive and
  definite/potential impact classifications.
- Current-working-tree source snippets constrained by `maxSourceSnippetLines` and always labeled
  `untrusted_repository_content`.
- Opaque query-bound pagination cursors and a configurable 20-path default execution-path limit.
- Accuracy tests covering automatic dirty-tree refresh, current source locations, source limits,
  multi-candidate resolution, deletion cleanup, rename identity, pagination, and provenance.

### Changed

- Every required MCP tool now returns grounded facts, confidence, freshness, evidence, and explicit
  uncertainty instead of stubbed empty results.
- Search results and node facts expose stable node IDs for follow-up node, source, dependency, and
  traversal queries.
- CodeAtlas is version `0.7.0`; the graph schema remains version 3 and does not require migration.

## 0.6.0 - 2026-08-27

### Added

- Phase 6 deterministic feature and domain grouping with evidence-bearing membership edges.
- Dependency-community discovery and persisted file-level fan-in, fan-out, dependency-depth,
  cross-domain, line-count, and Git-history metrics.
- Circular-dependency, high-coupling, large-file, large-symbol, and churn/connectivity hotspot
  signals with configurable thresholds.
- Schema 3 architecture metric, finding, and dependency-community storage.
- Graph-backed, paginated `codeatlas_overview` and `codeatlas_health` MCP responses with facts,
  relationships, evidence, confidence, freshness, and heuristic uncertainty labels.
- Medium-repository tests covering features, domains, communities, cycles, coupling, hotspots,
  pagination, and MCP evidence.

### Changed

- Indexing now recomputes graph-only architecture analysis transactionally after affected graph
  sections are refreshed, without reparsing unrelated files.
- Git history analysis is bounded to 500 commits in a 90-day window and persists aggregate counts,
  hashes, and dates rather than commit diffs or contributor identities.
- The database schema is now version 3, the indexing contract is `architecture-6`, and CodeAtlas
  is version `0.6.0`.

## 0.5.0 - 2026-08-27

### Added

- Phase 5 framework-adapter registry kept separate from generic language parsing.
- Express and FastAPI route extraction with `api_route`, `EXPOSES`, and `HANDLES` graph facts.
- Prisma and SQLAlchemy model extraction with `database_model`, containment, mapped-class, and
  local model-reference relationships.
- Source evidence, deterministic IDs, literal-safe route/table hashes, framework counts, and
  known framework fixture coverage.
- Optional `analysis.frameworks` configuration with backward-compatible enablement for existing
  version 1 configurations.

### Changed

- Index results, initialization output, status, manifest, and state now report API routes,
  database models, and detected frameworks.
- Configuration changes now trigger a required transactional rebuild so optional analyses cannot
  leave stale semantic nodes.
- The indexing contract is now `frameworks-5` and CodeAtlas is version `0.5.0`.

## 0.4.0 - 2026-08-27

### Added

- Phase 4 Git-state classification for added, modified, deleted, and renamed files.
- Reverse dependency-neighborhood invalidation with unresolved-import wakeups.
- Git rename identity preservation at the specified 50% similarity threshold.
- Evidence-bearing `RENAMED_FROM` edges with Git provenance and 0.95 confidence.
- Incremental regression coverage for committed, staged, uncommitted, hidden, deleted, and
  renamed changes.
- Critical MCP freshness coverage that verifies obsolete relationships are removed before a
  response is returned.

### Changed

- Indexing algorithm version is now `incremental-4` and CodeAtlas is version `0.4.0`.
- Required full rebuilds are automatic for indexer-version, repository-root, or inconsistent Git
  history changes.
- Index results now report direct change categories, dependency invalidations, rename counts,
  dirty state, and full-rebuild status.

## 0.3.0 - 2026-08-27

### Added

- Phase 3 import, call, inheritance, implementation, and general-reference resolution.
- Explicit unresolved and multi-candidate records without persisted module-specifier values.
- Import-graph-distance confidence scaling for ambiguous candidate edges.
- Official MCP SDK stdio server with all ten required tools and typed Answer Packets.
- Mandatory MCP freshness synchronization and configured traversal/result limits.
- Exact relationship snapshots and end-to-end stdio MCP contract tests.

### Changed

- The database schema is now version 2 and the index contract is `relationships-3`.
- CLI and MCP status treat schema/indexer version drift as out of date.

## 0.2.0 - 2026-08-26

### Added

- Phase 2 Tree-sitter structural indexing for TypeScript, JavaScript, TSX, JSX, and Python.
- Deterministic module, class, interface, function, method, and variable graph nodes.
- Provenance-bearing containment and export relationships.
- Normalized transient import/export references for Phase 3 resolution.
- Literal-redacted signatures and parser diagnostics.
- Per-language fixture repositories and exact normalized graph snapshots.

### Changed

- Initial and incremental indexing now writes AST entities transactionally.
- `status`, `doctor`, and CLI summaries report structural parser information.
- The runtime baseline now follows the specification's current-LTS target: Node.js 24.

## 0.1.0 - 2026-08-26

### Added

- Phase 1 TypeScript CLI foundation.
- Git repository detection and canonical working-tree fingerprints.
- Local workspace, strict configuration, ignore rules, and secret-path protection.
- SQLite schema, WAL mode, migrations, FTS5, and transactional metadata indexing.
- Deterministic structural graph nodes/edges with provenance.
- Status, doctor, safe clean, unit tests, and Git-backed integration tests.
