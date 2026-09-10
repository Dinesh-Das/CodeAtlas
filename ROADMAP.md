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
- A task-context compiler that resolves explicit anchors, returns evidence-complete edit and
  validation context within a byte budget, filters fixture decoys, and incorporates scoped owners,
  invariants, canonical names, and architecture rules.
- Bounded SQLite projections and lazy evidence hydration for the default MCP tools and progressive
  resources, with per-response storage, latency, and resident-memory telemetry.
- Type checking, linting, coverage, dependency audit, CodeQL, package smoke tests, multi-OS CI, and
  a release-evidence gate tied to the exact packed artifact.

## Next

- Run and publish held-out paired provider evaluations that measure context cost, required-file
  recall, wrong edit locations, irrelevant tests, unsupported claims, and validated task success.
- Extend the paired evaluation corpus with executable changes in disposable repositories and
  task-specific patch validation.
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
