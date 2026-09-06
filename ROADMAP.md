# CodeAtlas roadmap

CodeAtlas prioritizes incorrect or missing evidence on real repositories over feature count. This
file is the single source for planned work; completed behavior belongs in the README and changelog.

## Release-readiness criteria

- Validate the packed artifact on at least ten independent repositories across Linux, macOS,
  Windows, TypeScript, JavaScript, and Python.
- Keep a regression fixture for every corrected graph edge, control-flow case, and framework gap.
- Track cold/incremental build time, query latency, peak memory, and database size.
- Report known compiler, parser, and framework limits through `codeatlas doctor` and canonical
  uncertainty records.
- Prove install → build → overview → MCP-question workflows on every supported operating system.

## Completed in the current working tree

- Canonical IR 1.2 with scoped evidence hashes, excerpt status, resolution issues, relationship
  uncertainty, CFG capability metadata, and in-memory compatibility for IR 1.0 and 1.1 snapshots.
- A 19-tool canonical MCP surface with validated read-only contracts, bounded pagination, typed
  recoverable errors, freshness/generation metadata, and explicit uncertainty counts.
- Structured control-flow lowering for supported JavaScript, TypeScript, and Python branches,
  loops, abrupt exits, and try/catch/finally paths.
- Interactive offline architecture, sequence, and control-flow diagrams with SVG export plus
  deterministic Markdown and Mermaid projections.
- Public registration APIs for third-party language and framework adapters.
- Scope-aware architecture, branch-preserving execution/impact paths, architecture rules, Git
  changes, snapshots, and deterministic review findings.
- Type checking, linting, coverage, dependency audit, CodeQL, package smoke tests, multi-OS CI, and
  a release-evidence gate tied to the exact packed artifact.

## Next

- Build an outcome-evaluation harness and a pinned development corpus that measures whether
  evidence improves architecture discovery, change planning, and impact analysis.
- Add a task-context compiler that returns the smallest evidence-complete packet for a requested
  change, including relevant tests, rules, unresolved boundaries, and token/byte budgets.
- Query large canonical artifacts from indexes and projections without loading the entire atlas for
  every request.
- Improve framework projection incrementality and TypeScript compiler memory reuse in large
  monorepos.
- Broaden Fastify, Prisma, and cross-language contract fixtures from real public repositories.
- Improve deterministic architecture naming and recommended starting points with explicit
  confidence and evidence.

## Later

- Add system/contract projections for HTTP schemas, queues/events, dependency injection, and data
  stores where the source provides enough evidence.
- Add optional local semantic candidate retrieval while keeping graph/compiler evidence as the
  relationship validator.
- Expand language and framework adapters based on demonstrated demand.
- Add extension hooks for third-party retrieval strategies.

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing or implementing a roadmap item.
