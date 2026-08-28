# CodeAtlas large-repository hardening report

Date: 2026-08-28
Measured environment: Windows x64, Node.js 24.12.0

## 1. Problems confirmed

- Structural facts could commit before architecture without any stored generation boundary, so a
  crash could make stale derived data appear current.
- Reverse invalidation caps could stop traversal without proving the remaining graph safe.
- TypeScript declaration lookup could collapse duplicate methods by file/name, and ambiguous
  candidate limits were applied before repository scope and import reachability.
- Repeated MCP freshness checks invoked Git; trace and impact issued one edge query per visited node.
- Full and incremental persistence updated an FTS table whose text ID was unindexed. Updates and
  deletes scanned FTS content, while the FTS table duplicated searchable node content.
- TypeScript compiler/project work, candidate generation, file reading, architecture stages, and
  actual peak RSS were not independently observable.
- The Fastify patterns used by freeCodeCamp were not covered, producing zero API routes.
- Louvain stopped after local moving, and post-SCC finding construction repeatedly rescanned edges.
- Synthetic 500k/1M profiles existed but had not been executed; no detached-worktree real-repo
  suite existed.

## 2. Changes made

- Added structural, semantic, search, and architecture generations. Structural/semantic/FTS facts
  advance atomically; architecture is computed outside the write lock and atomically published at
  the source generation. Tool-specific freshness gates repair only the required stale layer.
- Made invalidation return explicit depth/file truncation metadata and fall back to full
  reconciliation before committing when completeness cannot be proven.
- Reworked TS resolution around exact compiler declaration file/range/qualified identity, cached
  projects/programs/source-call maps, wildcard exports, declared workspaces only, and scope-first
  candidate ranking. Incremental symbol loading is limited to relevant files/names.
- Added an event-invalidated process status cache with 30-second authoritative reconciliation,
  assume-unchanged hashing, no-change early exit, generation-aware status, and coalesced refreshes.
- Batched trace/impact traversal by frontier and cached queued trace adjacency. Uncertainty queries
  now inspect returned-page nodes rather than every traversed node.
- Added schema 6 external-content FTS keyed by SQLite rowid, cached hot prepared statements, and a
  transactional bulk FTS rebuild for explicit full indexes. This removed duplicated FTS content
  and the unindexed-ID update scan.
- Added deterministic multilevel Louvain aggregation and single-pass SCC edge bucketing.
- Added a generalized Fastify adapter for shorthand HTTP methods and `route({...})`, including
  method arrays and handler relationships. Route literals remain hashed.
- Added 22 structured phases with elapsed/work time, item/reuse/cache counters, progress events,
  RSS/heap samples, and externally sampled peak RSS in benchmarks. `index --json` and `--quiet`
  provide automation-friendly output.
- Expanded `doctor` with import categories, relationship provenance percentages, parser paths and
  generated/source classification, and top SQLite objects from `dbstat`.
- Added balanced overview paging across domains, features, packages, entrypoints, communities,
  routes, and models.
- Added controlled 10k-1M fixtures plus a detached-worktree real-repository harness covering cold,
  no-change, implementation/export/shared-package changes, 5/10 files, rename, deletion, CPU/RSS,
  query p50/p95/p99, DB objects, and correctness counts. It never modifies the source checkout.

## 3. Before/after benchmarks

The "before" freeCodeCamp column is the measured schema-5 run captured during this implementation
after the earlier semantic work but before batched traversal, the watched 30-second freshness path,
and schema-6 FTS. The original audited build had no trustworthy numeric cold/full result; it was
reported only as unacceptably long/appearing hung.

Repository: freeCodeCamp commit `6d0d89755eb233631adfdb5d44596339c5bbe97b`, 19,424 cold-indexed
files (19,423 after the final deletion scenario), 1,180 tracked JS/TS files, and 220,775 JS/TS LOC.

| Real scenario | Before | Final | Change |
| --- | ---: | ---: | ---: |
| Cold/full | 439.46 s | **119.20 s** | 72.9% faster |
| Authoritative no-change | 1,472 ms | **907 ms** | 38.4% faster |
| One implementation file | 31.93 s | **7.23 s** | 77.3% faster |
| Exported symbol | 47.03 s | **8.18 s** | 82.6% faster |
| Shared-package file | 30.45 s | **6.88 s** | 77.4% faster |
| Five low-impact files | 46.36 s | **8.43 s** | 81.8% faster |
| Ten low-impact files | 62.99 s | **10.32 s** | 83.6% faster |
| Rename | 31.15 s | **7.16 s** | 77.0% faster |
| Deletion | 29.33 s | **6.11 s** | 79.2% faster |
| External peak RSS | 3,970.96 MB | **3,349.62 MB** | 15.6% lower |
| Database | 683.23 MB | **578.00 MB** | 15.4% smaller |

Cold CPU time was 130.19 s. Startup RSS was 117.1 MB, but post-query RSS remained 3,132.8 MB.
The cold critical phases were DB writes 97.49 s, graph resolution 68.61 s, candidate generation
26.80 s, TS semantic resolution 18.10 s, and 27 TS programs in 10.69 s. FTS bulk rebuild itself
was 1.06 s. A one-file edit still spends 2.08 s discovering 19,424 files, 1.43 s writing, 1.17 s
on architecture, and roughly 0.7-0.8 s each on history and fingerprint/Git work.

| freeCodeCamp query p95 | Before | Final | Target |
| --- | ---: | ---: | ---: |
| `get_node` | 36.27 ms | **5.20 ms** | <50 ms |
| dependencies | 27.33 ms | **4.08 ms** | <100 ms |
| search | 23.61 ms | **4.87 ms** | <200 ms |
| trace | 3,195.46 ms | **124.98 ms** | <300 ms |
| impact | 2,561.24 ms | **44.06 ms** | bounded traversal |
| overview | 66.40 ms | **22.76 ms** | interactive |
| unchanged freshness | 764.33 ms | **16.69 ms** | tens of ms |

Final p99s were 9.71/4.54/5.95/126.37/44.75/22.96/16.90 ms respectively.

Final controlled synthetic results use acyclic 100-file dependency clusters. Thus the 1/5/10
edit columns deliberately re-resolve 100/500/1,000 files and report `fullRebuild=false`.

| Fixture | Cold | No change | 100-file scope | 500-file scope | 1,000-file scope | Search p95 | Fresh p95 | Peak RSS | DB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100k LOC / 1,000 files | 9.98 s | 298 ms | 1.97 s | 7.08 s | 14.21 s | 12.39 ms | 9.46 ms | 273 MB | 12.54 MB |
| 500k LOC / 5,000 files | 20.60 s | 353 ms | 4.06 s | 7.45 s | 10.02 s | 17.70 ms | 5.49 ms | 367 MB | 62.15 MB |
| 1M LOC / 10,000 files | 35.93 s | 446 ms | 6.28 s | 12.98 s | 18.72 s | 25.51 ms | 3.77 ms | 460 MB | 124.96 MB |

Synthetic results validate controlled graph/DB scaling, not realistic compiler complexity. The real
freeCodeCamp peak is the relevant TS-monorepo memory result.

## 4. Correctness changes

- A simulated crash after structural commit now reports structural/semantic/search generation 2
  with architecture generation 1; structural tools remain usable and an architecture request
  repairs generation 2.
- A 15-dependent graph with a 10-file cap proves truncation is reported and forces full
  reconciliation rather than accepting incomplete relationships.
- Exact TS declaration tests distinguish duplicate same-name methods in one file. A 500-method
  test proves reachable/import-scoped candidates are selected before the 20-candidate cap.
- Wildcard workspace exports resolve; nested undeclared `package.json` files are not treated as
  workspaces.
- freeCodeCamp now yields 99 API route nodes instead of 0. Direct adapter validation found 63
  Fastify registrations across 18 API files; the full index also includes other detected routes.
- Final unresolved imports are categorized as 2,584 external dependencies, 62 internal unresolved,
  1 alias unresolved, and 7 ambiguous. External packages are not mislabeled actionable.
- The detached-worktree rename scenario reports one rename, zero adds/deletes, no full rebuild,
  and exactly one structural generation advance.
- Final edge provenance is 61,515 verified, 15,959 inferred, 101 dynamic, 124,042 documentation,
  and 20,709 Git edges. Parser failures remain visible for 19 files rather than being hidden.
- The largest final DB objects are nodes 139.45 MB, edges 125.89 MB, FTS data 35.59 MB, and
  resolution issues 29.93 MB. The former approximately 112 MB duplicate FTS content table is gone.

## 5. Tests added or strengthened

- Post-structural-commit crash recovery and exact generation assertions.
- Invalidation depth/file truncation fallback.
- Duplicate compiler declarations, 500 same-name methods, wildcard exports, and nested
  non-workspace manifests.
- Fastify shorthand/object route fixtures and incremental route removal.
- Ten thousand independent two-node SCCs plus the existing 20,000-node SCC regression.
- Multilevel community, balanced overview, cached generation status, phase telemetry, memory,
  JSON/quiet CLI, doctor storage/quality output, and schema-6 external FTS coverage.
- Existing parser snapshots, provenance/security, incremental rename/deletion/history, MCP accuracy,
  stdio protocol, architecture, search pagination, package, and CLI suites remain green.

Verification: **18 test files, 66 tests passed**; TypeScript typecheck/build and the packaged-install
smoke test passed. The repository does not define separate formatter or lint scripts.

## 6. Remaining limitations

- Real one-file updates are now bounded and much faster, but 6-8.5 seconds still misses the
  sub-2-second target. Repository discovery, persistence, resolver setup, Git history, and global
  architecture materialization remain end-to-end incremental work.
- freeCodeCamp peak RSS is 3.35 GB and post-run RSS is 3.07 GB. TS programs are scoped to an index
  run and reused within it, but V8 does not promptly return the compiler/graph high-water allocation
  in a long-lived process. This is the largest production-readiness blocker.
- Cold DB writes (97.5 s) and graph resolution (68.6 s) still dominate the 1.99-minute full run.
  Further gains require batched node/edge insertion and more persistent/incremental resolver and
  architecture materializations, not weaker analysis.
- The final real benchmark covers one large OSS monorepo. Two or three additional large repositories
  with different TS project-reference, generated-client, and polyglot shapes are still needed.
- Search is deterministic lexical/structural retrieval; optional local embeddings and wider graph
  expansion are not implemented.
- Python resolution remains indexed-package based rather than Pyright-complete.

## 7. Final assessment

- Small repositories: **ready**.
- 100k scale: **ready**, with measured bounded updates and low query latency.
- 500k scale: **experimentally ready**.
- 1M scale: **experimentally ready on controlled graphs**, not proven for arbitrary enterprise TS
  project graphs.
- freeCodeCamp scale: **credible developer-tool beta**. The initial 1.99-minute understanding pass
  is practical and all warm MCP p95 targets pass, but 6-10 second updates and 3.35 GB peak RSS mean
  it should not yet be marketed as unrestricted massive-monorepo production support.

Accepted benchmark artifacts are stored outside the repositories under
`D:\MyProjects\Benchmark\results\`: `codeatlas-freecodecamp-gitmv-final.json`,
`codeatlas-synthetic-100k-bulkfts.json`, `codeatlas-synthetic-500k-bulkfts-final.json`, and
`codeatlas-synthetic-1m-bulkfts-final.json`. The source freeCodeCamp checkout and its existing dirty
files were not modified.
