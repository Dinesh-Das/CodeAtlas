# CodeAtlas v2 implementation and release audit

This document began as the Phase 0 implementation plan. It is now the final implementation record
for the completed v2 architecture compiler work. The original architectural intent is preserved
where useful, but status statements below describe the implemented repository rather than the
pre-implementation baseline.

## 1. Current architecture

CodeAtlas 0.10 is a local TypeScript/Node.js application with a mature incremental indexing core:

- `src/cli` uses Commander and exposes the v2 `build`, `update`, `watch`, `ask`, `search`, `symbol`,
  `impact`, `diff`, `check`, `review`, and `snapshot` surfaces alongside compatibility commands
  `init`, `index`, `overview`, `status`, `setup`, `doctor`, `mcp`, and `clean`.
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

The production data flow is:

```text
repository -> Tree-sitter/framework adapters -> incremental graph resolver -> SQLite cache
                                                               |
                                                               v
                                                     canonical CodeAtlas IR
                                                       |       |       |
                                                       v       v       v
                                                    HTML    MCP/CLI snapshots
```

SQLite remains the local incremental compiler cache and query store. The portable product contract
is the versioned canonical IR exported under `.codeatlas/current`; the offline HTML application,
snapshots, architecture rules, structured flows/CFGs, impact indexes, review data, and agent/MCP
surfaces all consume that shared architecture model.

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

## 3. Resolved migration risks and remaining boundaries

The Phase 0 blockers were addressed incrementally without replacing the proven indexer:

- Stable graph identities are retained as canonical compatibility IDs while IR symbols also expose
  qualified names, locations, language, signatures, and navigation metadata.
- Evidence is first-class, deduplicated, deterministically identified, and cross-reference validated.
  AI answers and review findings pass through the same grounding validator.
- Canonical provenance/fact classes distinguish deterministic extraction and resolution from
  configuration, Git, heuristic, embedding, LLM, and user-defined facts where applicable.
- `.codeatlas/current`, snapshots, cache paths, manifests, and v1 compatibility paths coexist.
- `build` composes repository discovery, incremental indexing, IR compilation, exports, rules, and
  snapshots; `update` and `watch` reuse the same compiler path.
- `.codeatlas.yml` supports explicit domain overrides, architecture rules, analysis budgets, HTML
  output mode, and AI configuration. Explicit configuration wins over inferred grouping.
- The canonical IR-backed MCP surface exposes symbols, callers, impact, flows, CFGs, domains,
  evidence, rules, review findings, snapshots, and comparisons while preserving existing tools.
- CFGs, flow analysis, impact paths, architecture rules, review findings, and snapshot comparison are
  canonical deterministic projections rather than browser-only analysis.
- Large repositories use shared bounded projections/aggregation with complete search coverage instead
  of eagerly rendering every symbol.

Intentional boundaries remain: Git history, base/head architecture diffs, rename-history assistance,
and PR-oriented review require Git. Optional hosted AI/semantic enrichers are not prerequisites for
core indexing or the generated architecture report. No IDE extension, mandatory web server, CDN,
cloud database, Docker runtime, or external LLM is required for the core v2 workflow.

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

## 6. Implemented module map

The implementation added or extended the following areas:

- `src/ir/models.ts`, `schema.ts`, `evidence.ts`, `serialization.ts`, `validation.ts`, `loader.ts`, and
  evidence validation provide the public canonical model and grounding contract.
- `src/compiler/build.ts` is the canonical compiler pipeline.
- `src/analysis/flows.ts`, `control-flow.ts`, `impact.ts`, and `simplification.ts` provide shared IR
  projections.
- `src/export/*` produces canonical structured exports, Markdown agent context, self-contained HTML,
  and sharded bundle output.
- `src/git/snapshots.ts` and `src/git/architecture-diff.ts` provide persistent states and comparisons.
- `src/rules/*` provides declarative configuration, predicates, violations, and CI semantics.
- `src/review/*` provides deterministic architecture review plus evidence validation.
- CLI command modules provide build/update/watch, diff, check, review, snapshot, search/symbol,
  and impact; register them in `src/cli/index.ts`.
- `src/core/workspace.ts` exposes `current`, `snapshots`, `cache`, and agent export paths while
  preserving V1 paths.
- MCP schemas/server include v2 IR-backed tools for flow/evidence/snapshot/rule/review operations.
- End-to-end fixture repositories and acceptance tests cover IR exports, offline HTML, flows,
  CFGs, impact paths, rules, snapshots, and bounded rendering.
- README, security/privacy guidance, release checks, package smoke coverage, and benchmarks describe
  the verified behavior.

## 7. Implementation phases

All planned compiler slices are complete:

1. Complete — canonical IR, first-class evidence, deterministic serialization, and validation.
2. Complete — `build`/`update`/`watch` compiler orchestration and `.codeatlas/current` exports.
3. Complete — offline single-file HTML, bundle mode, and bounded multi-level projections.
4. Complete — deterministic domains, structured execution flows, CFGs, and impact indexes.
5. Complete — base/head Git overlays, changed-line symbol mapping, and snapshot comparison.
6. Complete — architecture rule engine, CI exit semantics, and deterministic review findings.
7. Complete — IR-backed MCP/agent surface, compact context exports, and evidence-grounded answers.
8. Complete — large-graph budgets, phase-level performance instrumentation, fixtures, privacy
   documentation, deterministic/reproducibility tests, and release/package hardening.

Compatibility is maintained throughout: V1 `init`, `index`, SQLite, setup, and current MCP tools
continue to work while v2 commands and artifacts are added incrementally.

## Implementation status

The production v2 compiler and all required public-release slices are implemented:

- Versioned canonical IR, deterministic sorting, stable compatibility IDs, first-class evidence,
  provenance/fact classes, content hashes, and cross-reference validation.
- `build`, `update`, and `watch` orchestration over the existing incremental indexer.
- `.codeatlas/current` JSON/JSONL exports, compact agent context, single-file offline HTML, optional
  bundle output, and persistent commit/worktree snapshots.
- Bounded multi-level HTML navigation, complete hidden-node search, structured entrypoint flows,
  bounded AST-derived CFGs, interactive impact traversal, Git/rule/review views, and source details.
- Large-repository rendering now consumes the shared IR projection layer rather than browser-only
  slicing. Default domain/module projections are deterministic and budgeted (150 visible nodes by
  default, 500 for selected-domain symbol expansion), surface explicit truncation warnings, and
  aggregate architectural dependency edges while excluding structural/history edges. Aggregate
  edges retain representative canonical relationship IDs for drill-down. Search still covers the
  complete IR, including human-readable domains, signatures/metadata, and evidence-backed endpoint
  text. High-degree utility hubs are detected without mutating the IR and can be hidden, collapsed
  into a summary supernode, or shown in domain views.
- Explainable impact scores and paths, Git hunk-to-symbol mapping, and deterministic architecture
  snapshot evolution covering domains, dependencies, APIs, dependency cycles, centrality changes,
  and introduced/resolved rule violations. Explicit `.codeatlas.yml` domains, reusable rule
  predicates, CI exit behavior, and deterministic evidence-gated review findings are also supported.
  `depends_on` evaluates direct architectural dependency edges such as calls/imports/references and
  excludes structural/history projections such as containment, exports, memberships, route-prefix
  composition, and rename history. Rule-path evaluation keeps alternate paths independent so an
  allowed `unless_via` route cannot hide a separate violating route.
- Canonical-IR MCP tools and deterministic evidence-grounded `ask` answers. Canonical MCP list
  queries enforce repository-configured result/traversal budgets, expose fingerprint-bound cursors
  with explicit pagination metadata, reuse the same rich symbol search text as the HTML explorer,
  and return compact follow-up guidance rather than requiring agents to scrape the report.
- Evidence-grounded answers and review findings share a canonical grounding validator. Evidence IDs
  are accepted only when their indexed file, line/column range, excerpt, symbol/relationship linkage,
  and available content hash can be resolved against the same snapshot; unsupported claims/findings
  are discarded instead of emitting fabricated source citations.
- End-to-end Authentication/Payments/Users fixture coverage plus offline, incremental, rule, flow,
  CFG, impact, snapshot, Git mapping, MCP parity, and 5,000-symbol LOD tests.
- Git-optional repository discovery and freshness. Ordinary directories use deterministic
  content/stat fingerprints, incremental file reuse, deletion cleanup, worktree-style snapshot IDs,
  null Git metadata in the canonical IR/build manifest, and filesystem-grounded MCP/status evidence.

Git history, base/head architecture diffs, rename-history assistance, and PR-oriented review remain
Git-only by design. Core indexing, canonical IR generation, HTML/agent exports, rules, impact,
domains, flows, CFGs, review over the current tree, and snapshots work in filesystem mode without
fabricating Git commits or `.git` evidence.

## Public-release Definition of Done

The original task's release checklist is satisfied by the implemented command surface, canonical IR
pipeline, fixtures, and acceptance/release tests:

| Requirement | Status | Implementation / verification |
|---|---|---|
| One-command repository build works | Complete | `codeatlas build [path]` compiles IR, exports, HTML, and snapshot. |
| Incremental indexing works | Complete | Content-hash reuse, semantic invalidation, deletion/rename cleanup, and incremental acceptance coverage. |
| Portable interactive HTML works offline | Complete | Self-contained `codeatlas.html` with no required CDN/network calls. |
| Canonical versioned IR exists | Complete | `src/ir/*` plus `.codeatlas/current/atlas.json` and JSON/JSONL projections. |
| Multi-level architecture drill-down works | Complete | Repository/domain/entrypoint/file-symbol/function-CFG projections with bounded navigation. |
| Domains/features are detected and overridable | Complete | Deterministic grouping plus `.codeatlas.yml` overrides. |
| Sequence diagrams work | Complete | Structured evidence-bearing entrypoint flows rendered from canonical IR. |
| Function CFGs work | Complete | Bounded AST-derived CFG nodes/edges with source evidence. |
| Symbol impact analysis works with explanatory paths | Complete | Forward/reverse impact indexes, paths, reasons, affected architecture, and explainable scoring. |
| Git base/head diff works | Complete | `codeatlas diff --base ... --head ...` builds/ref-compares canonical states and maps hunks to symbols. |
| Change overlays appear in HTML | Complete | Changes view carries labeled changed/impacted architecture projections. |
| Architecture rules work | Complete | Declarative `.codeatlas.yml` rules and evidence-bearing violations. |
| CI-friendly rule failure codes work | Complete | `codeatlas check` exits non-zero for configured error violations. |
| MCP exposes the architecture model | Complete | Canonical IR tools expose symbols, callers, impact, flows, CFG, domains, evidence, rules, review, and snapshots. |
| AI answers contain validated evidence | Complete | `codeatlas ask` uses the shared canonical grounding validator and emits only supported claims. |
| Code review uses diff + architecture impact | Complete | Review composes Git change mapping, impact, rules, and evidence-backed findings. |
| Unsupported AI findings are rejected | Complete | Invalid/missing/stale evidence is rejected before answer/review publication. |
| Snapshots persist per Git state | Complete | Commit/worktree architecture states are written under `.codeatlas/snapshots`. |
| Snapshot comparisons work | Complete | CLI/MCP snapshot comparison uses deterministic architecture diffs. |
| Large repositories use aggregation instead of graph spaghetti | Complete | Shared LOD budgets, domain/module aggregation, utility-hub handling, and 5,000-symbol tests. |
| HTML search covers the complete graph | Complete | Search index includes hidden/non-rendered symbols and rich architecture metadata. |
| No mandatory CDN/network dependency exists | Complete | Offline report is locally generated and self-contained; bundle mode also uses local assets/data. |
| Core indexing works with AI disabled | Complete | Parsing, graph construction, IR, analysis, rules, HTML, snapshots, and MCP are deterministic/local. |
| Tests cover the complete fixture workflow | Complete | End-to-end Authentication/Payments/Users fixture plus CLI/MCP/offline/incremental/diff/rule/CFG/impact/LOD tests. |
| Documentation explains privacy and optional external AI usage | Complete | README/security guidance documents local-first defaults and external-AI boundaries. |

## Final audit evidence

- `npm run release:check` passes the full check pipeline, package creation, disposable consumer
  installation, and installed CLI smoke test.
- The verified suite passes 31/31 test files and 124/124 tests, including deterministic structural
  IR, local-first privacy, evidence-gated AI, canonical workflow, CLI, package, adapter, and scale
  acceptance coverage.
- `npm run benchmark` smoke profile completes successfully. It exercises cold indexing, unchanged and
  targeted incremental updates, high-fan-out invalidation, warm search, freshness-aware queries, and
  phase-level timing/memory telemetry.
- Structural output determinism is tested independently from timestamp-bearing manifest/snapshot
  metadata.
- Release verification does not require an external AI provider, hosted graph/vector database,
  Docker, web server, IDE extension, CDN, or network connection for the generated HTML.
