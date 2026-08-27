# Changelog

All notable changes follow semantic versioning.

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
