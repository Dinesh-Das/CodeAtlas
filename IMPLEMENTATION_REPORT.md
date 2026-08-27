# CodeAtlas large-repository hardening report

Date: 2026-08-27  
Environment measured: Windows x64, Node.js 24.12.0

## Implemented

- Replaced repository-wide all-pairs import distances with indexed symbol lookup and bounded,
  on-demand traversal (depth 12, 5,000 visited modules, 128-source cache).
- Added TypeScript compiler-backed module resolution for `tsconfig.json`/`jsconfig.json`,
  `extends`, `baseUrl`, `paths`, NodeNext package rules, workspace exports, and receiver-aware call
  targets. Compiler-resolved relationships use verified provenance and the new `compiler` source
  type. Resolution failures remain unresolved or ambiguous.
- Added verified workspace `package` nodes, package membership, and internal package dependency
  edges from package manifests.
- Replaced connected components with deterministic first-phase Louvain modularity optimization.
  Replaced recursive Tarjan SCC traversal with an explicit stack and added a 20,000-node cycle
  regression. Dependency-depth calculation now scales as bounded graph-wide rounds instead of a
  BFS from every file.
- Added cross-layer feature discovery from shared symbol/path vocabulary, while labeling
  controllers/services/repositories/models as technical-layer domains.
- Added a fast MCP freshness path based on Git changed paths plus hashes of dirty files. It avoids
  repository discovery, caches unchanged dirty-file hashes, coalesces concurrent refreshes, and
  retains full CLI reconciliation as a fallback.
- Moved architecture computation outside the SQLite write transaction; only its replacement write
  is atomic. Index results and `.codeatlas/state.json` now include phase timings.
- Rebuilt MCP search normalization for developer questions, combining stop-word removal, OR-prefix
  FTS/BM25, exact identifier/prefix/path boosts, and SQL-backed cursor pages. Results beyond
  `maxMcpResultNodes` are reachable on later pages.
- Added package and graph-ranked entrypoint facts to repository overview output.
- Added schema 5 indexes for name resolution, edge traversal, and resolution-issue queries. The
  index contract is now `semantic-8`.
- Added `npm run benchmark` and `npm run benchmark:full`. The full profile generates 10k, 100k,
  500k, and 1M LOC fixtures and records cold/incremental phase timings, p50/p95 warm search,
  p50/p95 freshness-aware latency, observed RSS, and database size.
- Lowered the runtime floor from Node 24 to Node 22.12 and added Node 22.12 to the three-platform CI
  matrix. Node 20 was not selected because Commander requires Node >=22.12. `better-sqlite3` is
  pinned to the Node-22-compatible 12.8 line: 13.0.3 ships Node-API 10 binaries, whose actual Node
  22 floor is 22.14, despite declaring Node >=22, and its implicit Windows build path requires a
  compiler even when a bundled prebuild is present.

## Measurements

The harness did not exist before this change, so no trustworthy pre-change indexing baseline is
available. One search query-plan regression discovered by the new 100k benchmark was measured and
fixed: warm search improved from **2,127.9 ms p50 / 2,248.5 ms p95** to **16.43 ms p50 / 33.66 ms
p95** by driving the query directly from FTS rather than joining every node to an unindexed FTS
CTE.

| Generated fixture | Cold index | 1-file edit | 5-file edit | 10-file edit | Search p50/p95 | Fresh MCP p50/p95 | RSS | DB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10k LOC / 100 files | 1.19 s | 0.72 s | 0.74 s | 0.75 s | 5/5 ms | 214/242 ms | 130 MB | 1.8 MB |
| 100k LOC / 1,000 files | 12.22 s | 2.40 s | 2.22 s | 2.53 s | 16/34 ms | 236/279 ms | 237 MB | 15.1 MB |

The 100k incremental runs re-indexed 11, 15, and 20 files respectively because the generated
fixture is a dependency cycle and the configured reverse-neighborhood depth invalidates ten
dependents. Architecture recomputation remained the largest incremental phase at roughly
0.96-1.04 seconds.

## Regression coverage

- TypeScript paths, barrel exports, duplicated receiver method names, workspace package exports,
  and internal workspace dependencies.
- Natural-language search and cursor traversal past 200 initial candidates.
- Multiple dense communities inside one connected graph.
- Cross-directory business features in a layered architecture.
- A 20,000-node dependency cycle without call-stack recursion.
- Existing dirty/staged/untracked/deleted/renamed freshness, incremental indexing, parser,
  framework, architecture, MCP, CLI, provenance, and security invariants remain in the full suite.

## Known limitations and deferred work

- Architecture materialization is still global when the semantic graph changes. It is now outside
  the long write transaction and measured explicitly, but fully incremental communities,
  grouping, and findings require a future invalidation/materialization design.
- Ordinary MCP freshness no longer walks the repository, but it still invokes Git and may cost a
  few hundred milliseconds on Windows. A filesystem watcher/dirty journal could reduce this
  further; full reconciliation remains available through `codeatlas status`.
- TypeScript semantic programs are built lazily for receiver calls. Very large project-reference
  graphs need further memory profiling at the 500k/1M profiles.
- The full 500k and 1M benchmark profiles were added but not executed in this implementation run.
  Production claims at those sizes should wait for results on representative real monorepos as
  well as generated fixtures.
- Search is deterministic lexical/structural retrieval. It does not yet include optional local
  embeddings or broader graph-neighborhood expansion in the initial result page.
- Python package resolution now uses indexed package roots and `src/` layouts without repeated
  repository scans, but it does not yet use Pyright or the full range of Python packaging metadata.
- Louvain currently performs deterministic file-level local moving without multilevel graph
  aggregation. This is materially better than connected components, but should be compared with
  Leiden on larger real repositories.
