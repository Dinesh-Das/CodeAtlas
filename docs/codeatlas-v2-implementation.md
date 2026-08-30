# CodeAtlas v2 implementation plan

## 1. Current architecture

CodeAtlas 0.10 is a local TypeScript/Node.js application with a mature incremental indexing core:

- `src/cli` uses Commander and currently exposes `init`, `index`, `overview`, `status`, `setup`,
  `doctor`, `mcp`, and `clean`.
- `src/core` owns repository discovery support, nested Git ignore handling, safe workspace paths,
  content hashing, freshness, configuration, locking, and performance telemetry.
- `src/parser` uses Tree-sitter adapters for TypeScript, TSX, JavaScript, JSX, and Python. Parsers
  emit normalized graph nodes, graph edges, unresolved references, diagnostics, confidence, and
  source locations. Parser code is already separated from persistence and MCP.
- `src/framework` provides optional deterministic adapters for Express, Fastify, FastAPI, Prisma,
  and SQLAlchemy. Framework failures are isolated to the affected file.
- `src/graph` owns deterministic node/edge IDs, normalized graph contracts, TypeScript-aware
  resolution, dynamic-reference handling, and identity-preserving Git rename support.
- `src/indexer` performs hash-based incremental indexing, semantic invalidation, reverse dependency
  invalidation, transactional graph updates, deletion cleanup, and architecture recomputation.
- `src/storage` persists nodes, edges, file hashes/parser versions, unresolved references, semantic
  fingerprints, Git summaries, architecture metrics/findings, communities, FTS data, and generation
  state in a local SQLite database.
- `src/analysis` derives features, domains, communities, cycles, coupling, size, and change hotspots
  from the stored graph.
- `src/git` provides repository identity, worktree change detection, rename classification, and
  bounded history summaries.
- `src/mcp` exposes ten evidence-oriented graph tools through the official MCP SDK. Queries are
  freshness-gated and never parse source or scrape a visualization.
- Tests cover parser snapshots, framework extraction, TypeScript resolution, incremental deletion
  and rename behavior, architecture analysis, search, MCP accuracy, and compiled CLI/MCP behavior.

The current data flow is:

```text
repository -> Tree-sitter/framework adapters -> incremental graph resolver -> SQLite
                                                               |              |
                                                               v              v
                                                       architecture analysis  MCP/CLI
```

SQLite is currently the authoritative runtime store, but there is no stable portable IR export,
offline architecture application, snapshot contract, rule engine, structured flow/CFG model, or
single `build` command.

## 2. Existing components to reuse

The v2 compiler will reuse the following rather than replace them:

- Content-hash discovery, `.gitignore`/`.codeatlasignore`, secret ignores, symlink containment, and
  the single-writer lock.
- Tree-sitter language adapters and deterministic source locations.
- Framework adapters and their route/model relationship materialization.
- Stable existing graph identity, including IDs preserved across high-confidence Git renames.
- TypeScript compiler-assisted resolution and explicit ambiguous/unresolved-reference records.
- Incremental semantic fingerprints, reverse invalidation, transactional cleanup, and FTS search.
- Existing deterministic feature/domain/community and architecture-signal analysis.
- Existing graph traversal, impact, execution trace, evidence extraction, and MCP freshness gate.
- Existing Git change and bounded history logic.
- SQLite as a local compiler cache/query store. It remains an implementation detail and optional
  high-performance adapter; exported CodeAtlas IR becomes the portable product contract.

## 3. Technical debt and blockers

- Graph IDs are stable hashes and therefore compatible, but not human-readable. The IR will retain
  them as canonical compatibility IDs and expose qualified names/locations for human navigation.
- Evidence is embedded in node/edge metadata and MCP packets rather than stored as first-class
  canonical entities. It must be deduplicated, assigned stable IDs, and reference-validated.
- Provenance vocabularies use lower-case source/provenance categories; the IR needs the explicit
  compiler-facing `AST`, `STATIC_ANALYSIS`, `CONFIG`, `GIT`, `HEURISTIC`, `EMBEDDING`, `LLM`, and
  `USER_DEFINED` contract without losing existing detail.
- The workspace layout (`atlas.db`, `manifest.json`, `state.json`) predates `.codeatlas/current/`
  and snapshots. Compatibility files must remain readable during migration.
- `init` and `index` remain separate compatibility commands while `build` composes initialization,
  incremental indexing, compilation, exports, and snapshots. Repository discovery now supports both
  Git worktrees and ordinary filesystem directories; Git-only history/diff capabilities remain
  conditional on Git being available.
- Domain configuration is JSON feature overrides, not `.codeatlas.yml` domain/rule configuration.
- Existing MCP trace/impact tools operate on the same graph but do not yet expose every v2
  task-specific name (flows, CFG, snapshots, rules, review).
- Control-flow graphs, architecture rules, deterministic review findings, and snapshot comparisons
  require new canonical analysis modules.
- Rendering thousands of raw nodes would be unusable. HTML must render bounded projections and
  retain a complete search index rather than eagerly instantiating the full graph.

No Neo4j, Qdrant, cloud database, GraphRAG service, external LLM, Docker runtime, or IDE extension
exists in this revision, so none is a migration prerequisite. Optional enrichers can be added later
as consumers of the IR.

## 4. Proposed canonical IR

`src/ir` defines a versioned, deterministic `Atlas` document. It contains repository/snapshot
metadata and sorted collections of symbols, relationships, evidence, domains, entrypoints, flows,
control-flow graphs, impact indexes, Git changes, architecture rules/violations, and review
findings.

Core invariants:

1. `schema_version` is explicit and independently versioned from the SQLite schema.
2. Every entity has a deterministic ID.
3. Every relationship is typed, directed, confidence-bearing, and provenance-bearing.
4. Every located symbol and relationship references first-class evidence.
5. Every cross-reference is validated before publication.
6. Arrays and map keys are normalized and sorted before serialization.
7. Generated timestamps live only in snapshot/manifest metadata, not semantic equality inputs.
8. Structural analysis remains deterministic and local. Optional AI output must use validated
   evidence IDs and remain distinguishable from source facts.

The initial IR is intentionally an adapter over the proven stored graph. The compiler performs:

```text
SQLite graph/cache
  -> canonical node/edge/evidence normalization
  -> projections (domains, flows, CFG, impact, Git, rules, review)
  -> validate
  -> deterministic exports
```

## 5. Mapping from current components to the new architecture

| Current component | v2 role |
|---|---|
| `src/graph/types.ts` | Internal extraction graph contract feeding IR conversion |
| `src/graph/ids.ts` | Compatibility identities and deterministic ID primitives |
| `src/indexer/*` | Incremental compiler front end/cache population |
| `src/storage/*` | Local cache and high-performance graph query adapter |
| `src/analysis/grouping.ts` | Baseline domain/feature projection |
| `src/analysis/graph.ts` | Shared graph loading for projections |
| `src/mcp/graph-tools.ts` | Existing traversal semantics, progressively redirected to IR services |
| `src/git/*` | Current-worktree and base/head change inputs |
| `src/framework/*` | Framework entrypoint/database extraction adapters |
| New `src/ir/*` | Public canonical schema, normalization, serialization, validation, loader |
| New `src/compiler/*` | One orchestration path used by build/update/watch and exporters |
| New `src/export/*` | JSONL/JSON, Markdown, and self-contained offline HTML views |
| New `src/analysis/{flows,control-flow,impact,simplification}.ts` | IR projections |
| New `src/rules/*` | Declarative predicates and evidence-bearing violations |
| New `src/git/snapshots.ts` | Persistent architecture states and deterministic comparisons |
| New `src/review/*` | Diff + impact + rule-derived findings and AI evidence gating |

## 6. Exact files/modules to add or change

Initial implementation:

- Add `src/ir/models.ts`, `schema.ts`, `evidence.ts`, `serialization.ts`, `validation.ts`, and
  `loader.ts`.
- Add `src/compiler/build.ts` as the canonical compiler pipeline.
- Add `src/analysis/flows.ts`, `control-flow.ts`, `impact.ts`, and `simplification.ts`.
- Add `src/export/json.ts`, `markdown.ts`, and `html.ts`.
- Add `src/git/snapshots.ts` and `src/git/architecture-diff.ts`.
- Add `src/rules/types.ts`, `config.ts`, and `engine.ts`.
- Add `src/review/review.ts` and `src/review/evidence-validation.ts`.
- Add CLI command modules for build/update/watch, diff, check, review, snapshot, search/symbol,
  and impact; register them in `src/cli/index.ts`.
- Extend `src/core/workspace.ts` with `current`, `snapshots`, `cache`, and agent export paths while
  preserving V1 paths.
- Extend MCP schemas/server with v2 IR-backed aliases and new flow/evidence/snapshot/rule tools.
- Add end-to-end fixture repositories and acceptance tests for IR exports, offline HTML, flows,
  CFGs, impact paths, rules, snapshots, and bounded rendering.
- Update README/security/release documentation only after behavior is implemented and verified.

## 7. Implementation phases

1. Canonical IR, first-class evidence, deterministic serialization, and validation.
2. `build`/`update` compiler orchestration and `.codeatlas/current` exports.
3. Offline single-file HTML and bounded multi-level projections.
4. Deterministic domains, structured execution flows, CFGs, and impact indexes.
5. Base/head Git overlays and persistent snapshot comparison.
6. Architecture rule engine, CI exit semantics, and deterministic review findings.
7. Complete IR-backed MCP surface and compact agent context exports.
8. Large-graph budgets, performance instrumentation, fixtures, privacy documentation, and release
   hardening.

Compatibility is maintained throughout: V1 `init`, `index`, SQLite, setup, and current MCP tools
continue to work while v2 commands and artifacts are added incrementally.

## Implementation status

The first production compiler slice is implemented:

- Versioned canonical IR, deterministic sorting, stable compatibility IDs, first-class evidence,
  provenance/fact classes, content hashes, and cross-reference validation.
- `build`, `update`, and `watch` orchestration over the existing incremental indexer.
- `.codeatlas/current` JSON/JSONL exports, compact agent context, single-file offline HTML, optional
  bundle output, and persistent commit/worktree snapshots.
- Bounded multi-level HTML navigation, complete hidden-node search, structured entrypoint flows,
  bounded AST-derived CFGs, interactive impact traversal, Git/rule/review views, and source details.
- Explainable impact scores and paths, Git hunk-to-symbol mapping, and deterministic architecture
  snapshot evolution covering domains, dependencies, APIs, dependency cycles, centrality changes,
  and introduced/resolved rule violations. Explicit `.codeatlas.yml` domains, reusable rule
  predicates, CI exit behavior, and deterministic evidence-gated review findings are also supported.
  `depends_on` evaluates direct architectural dependency edges such as calls/imports/references and
  excludes structural/history projections such as containment, exports, memberships, route-prefix
  composition, and rename history. Rule-path evaluation keeps alternate paths independent so an
  allowed `unless_via` route cannot hide a separate violating route.
- Canonical-IR MCP tools and deterministic evidence-grounded `ask` answers.
- End-to-end Authentication/Payments/Users fixture coverage plus offline, incremental, rule, flow,
  CFG, impact, snapshot, Git mapping, MCP parity, and 5,000-symbol LOD tests.
- Git-optional repository discovery and freshness. Ordinary directories use deterministic
  content/stat fingerprints, incremental file reuse, deletion cleanup, worktree-style snapshot IDs,
  null Git metadata in the canonical IR/build manifest, and filesystem-grounded MCP/status evidence.

Git history, base/head architecture diffs, rename-history assistance, and PR-oriented review remain
Git-only by design. Core indexing, canonical IR generation, HTML/agent exports, rules, impact,
domains, flows, CFGs, review over the current tree, and snapshots work in filesystem mode without
fabricating Git commits or `.git` evidence.
