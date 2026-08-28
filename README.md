# CodeAtlas

CodeAtlas builds a living knowledge graph of your Git repository and exposes it to AI coding
agents through MCP. Instead of repeatedly searching the entire codebase, an agent can ask how
features, modules, functions, APIs, and data models are connected and receive current file/line
evidence.

The complete MVP includes structural parsing, relationship resolution, incremental indexing,
framework adapters, architecture analysis, grounded MCP queries, and release packaging.

The governing principle is simple: the working tree owns the facts, deterministic analysis
structures those facts, and an LLM may explain them later.

## What is implemented

- TypeScript/Node.js CLI with `init`, `index`, `status`, `doctor`, and safe `clean` commands.
- Git-root detection with an explicit V1 error for non-Git directories.
- Local `.codeatlas/` workspace creation and idempotent `.gitignore` integration.
- Strict, versioned configuration. Invalid configuration is never silently replaced.
- `.gitignore`, nested `.gitignore`, `.codeatlasignore`, generated-directory, and secret-file
  exclusions.
- External-repository symlink protection.
- SHA-256 file hashing and the canonical tracked/untracked repository fingerprint.
- SQLite graph storage with versioned transactional migrations, foreign keys, FTS5, and WAL.
- Deterministic repository, package, directory, file, and `CONTAINS` graph entities with provenance;
  internal workspace-package dependencies are verified from package manifests.
- Tree-sitter adapters for TypeScript, JavaScript, TSX, JSX, and Python.
- Evidence-bearing module, class, interface, function, method, and variable nodes.
- Deterministic `CONTAINS`, `EXPORTS`, `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`, and
  `REFERENCES` relationships.
- Project-aware TypeScript resolution through the compiler API, including `tsconfig`/`jsconfig`
  inheritance, `baseUrl`, `paths`, Node package exports, workspace packages, and receiver-type
  verification for call targets when compiler evidence is available.
- Explicit unresolved and multi-candidate resolution records; ambiguous edges use confidence
  scaled by bounded, on-demand import-graph distance.
- Explicit dynamic analysis for callbacks, async continuations, event emitters, queues,
  dependency-injection containers, runtime registration, reflection, polymorphic calls, and
  generated code. Candidate targets have reduced confidence; unverifiable targets remain
  explicit diagnostics.
- First-class provenance categories on every graph node and edge: `verified`, `inferred`,
  `dynamic`, `documentation`, `git`, and `unresolved`.
- Literal-safe signatures that redact assigned/default string values before persistence.
- Transactional structural/semantic/search indexing, generation-tracked architecture
  materialization, deleted-file cleanup, status checks, and a single-writer workspace lock.
- Git-derived added/modified/deleted/renamed change classification backed by authoritative file
  hashes, including dirty and committed changes.
- Reverse dependency-neighborhood invalidation so changed targets re-resolve their callers without
  reparsing unrelated files.
- Identity-preserving Git renames at 50% or greater similarity, recorded with `RENAMED_FROM`
  provenance edges; lower-similarity moves remain delete plus create.
- Optional, separately registered framework adapters for Express, Fastify, FastAPI, Prisma, and
  SQLAlchemy.
- Evidence-bearing `api_route` and `database_model` nodes with `EXPOSES`, `HANDLES`,
  `CONTAINS`, and `REFERENCES` relationships.
- Deterministic feature/domain grouping and modularity-optimized dependency communities derived
  from the current graph, including cross-layer business vocabulary signals.
- Weighted feature evidence from directory boundaries, symbol vocabulary, routes, tests, imports,
  database models, and dependency communities, with configuration-based manual overrides.
- README, ADR, documentation-heading, intent-comment, and test-file indexing that remains clearly
  separated from deterministic code facts and bounded Git-history explanations.
- Persisted fan-in, fan-out, dependency depth, cross-domain coupling, size, and bounded Git-history
  metrics.
- Evidence-bearing cycle, high-coupling, large-symbol/file, and churn/connectivity hotspot signals.
- Meaningful, paginated `codeatlas_overview` and `codeatlas_health` MCP responses.
- Graph-backed status, search, node detail, feature explanation, execution trace, impact,
  dependency-neighborhood, and current-source MCP responses.
- Bounded traversal, definite-versus-potential impact classification, opaque query-bound cursors,
  ambiguity reporting, and stable node IDs for follow-up queries.
- Natural-query normalization, FTS/BM25, exact symbol, prefix, path, package, and architecture
  retrieval with database-backed cursor pagination beyond per-page resource caps.
- Current-working-tree source excerpts capped by configuration, path-contained within the
  repository, and labeled `untrusted_repository_content`.
- Official-SDK MCP stdio server with all ten required tools, validated inputs, typed Answer
  Packets, configured limits, and a Git-indexed freshness gate that hashes only dirty paths.
- Repeatable generated-repository benchmarks (`npm run benchmark` and `npm run benchmark:full`)
  plus detached-worktree real-repository scenarios (`npm run benchmark:real -- --repository PATH`),
  with detailed phase work, p50/p95/p99 queries, external peak RSS, and database size.
- Evidence-only MCP policy metadata that marks repository content untrusted, indexing local-only,
  and external LLM/provider behavior as outside CodeAtlas.
- Expanded `codeatlas doctor` diagnostics for unsupported languages, unresolved imports, dynamic
  relationships, parser failures, stale files, graph corruption, and framework coverage gaps.
- Parser and call-graph snapshots plus unit, integration, compiled-CLI, and MCP protocol tests
  using disposable Git repositories.

All ten required MCP tools return grounded Answer Packets. Structural facts and relationships
carry confidence and file/line evidence; unresolved or ambiguous queries explicitly report an
uncertainty rather than selecting a candidate silently.

## Requirements

- Node.js 22.12 or newer
- Git
- npm

CI verifies the project on Linux, macOS, and Windows.

Non-Git directories are not supported in V1. Docker, an API key, a cloud account, and a separate
database service are not required.

## Installation

Install the scoped npm package globally. The installed executable remains `codeatlas`:

```bash
npm install --global @dinesh-das/codeatlas
codeatlas --version
```

The unscoped npm name `codeatlas` belongs to an unrelated package; use the scoped package shown
above.

## Getting started

From any directory inside the Git repository you want to understand:

```bash
codeatlas init
codeatlas status
codeatlas mcp
```

`init` creates the ignored local `.codeatlas/` workspace and performs the first index. `mcp`
starts the stdio server and normally runs under an MCP-compatible coding agent rather than in a
terminal you interact with directly.

## Development setup

```bash
npm install
npm run check
npm link
```

Then, from a Git repository you want to index:

```bash
codeatlas init
codeatlas status
```

For local development without linking globally:

```bash
node /absolute/path/to/CodeAtlas/dist/cli/index.js init
```

## Commands

```text
codeatlas init [path]         Create the workspace and initial structural graph
codeatlas index [path]        Synchronize changes and their dependency neighborhoods
codeatlas index --full [path] Rebuild the structural graph transactionally
codeatlas index --quiet       Suppress progress output
codeatlas index --json        Emit a machine-readable result (progress stays on stderr)
codeatlas status [path]       Compare the working tree with the stored fingerprint
codeatlas status --json       Return machine-readable status
codeatlas doctor [path]       Check Node, parsers, Git, config, SQLite, and WAL
codeatlas clean [path]        Remove the local index after confirmation
codeatlas clean --force       Remove it non-interactively
codeatlas mcp [path]          Start the CodeAtlas MCP server over stdio
```

## Local workspace

`codeatlas init` creates only local, ignored state:

```text
.codeatlas/
├── atlas.db
├── config.json
├── manifest.json
├── state.json
└── logs/
```

`.codeatlas/` is added to `.gitignore` exactly once. The `lock` file exists only while an
index writer owns the workspace.

The database stores structural metadata and hashes, not complete source files or string literal
values. Import module values used during resolution remain transient; unresolved import records
store only a SHA-256 hash. Source contents remain in the working tree.

## MCP setup

Configure an MCP-compatible host to launch `codeatlas mcp` with the repository as its working
directory, or pass the repository path explicitly:

```bash
codeatlas mcp /absolute/path/to/repository
```

A typical MCP client entry is:

```json
{
  "mcpServers": {
    "codeatlas": {
      "command": "codeatlas",
      "args": ["mcp", "/absolute/path/to/repository"]
    }
  }
}
```

Copy the server object into the MCP configuration supported by your coding agent and replace the
path with an absolute repository path. A copyable file is available at
[`examples/mcp-config.json`](examples/mcp-config.json). If the agent was already running when
CodeAtlas was installed, restart it so the new executable is available on `PATH`.

The server uses stdio and writes no protocol-breaking output to stdout. Every tool request first
checks the current repository fingerprint and performs an incremental index update when needed.
All source snippets in the stable Answer Packet contract are labeled
`untrusted_repository_content`. Empty or ambiguous results return explicit uncertainty such as
`insufficient_evidence`, `unresolved_reference`, or `dynamic_relationship`; the MCP layer never
manufactures a missing relationship or answer.

The available tools are `codeatlas_status`, `codeatlas_overview`, `codeatlas_search`,
`codeatlas_get_node`, `codeatlas_explain_feature`, `codeatlas_trace`, `codeatlas_impact`,
`codeatlas_dependencies`, `codeatlas_source`, and `codeatlas_health`. Search and other node facts
include a stable `node_id` in their statement so a client can pass it to follow-up tools.

| Tool | Purpose |
|---|---|
| `codeatlas_status` | Repository, commit, dirty-tree, language, and index status |
| `codeatlas_overview` | Domains, features, communities, entrypoints, and models |
| `codeatlas_search` | Search features, symbols, APIs, files, and models |
| `codeatlas_get_node` | Node metadata, location, memberships, and relationships |
| `codeatlas_explain_feature` | Grounded feature components and execution context |
| `codeatlas_trace` | Bounded evidence-bearing execution/dependency paths |
| `codeatlas_impact` | Definite and potential direct/transitive dependents |
| `codeatlas_dependencies` | Incoming and outgoing dependency neighborhood |
| `codeatlas_source` | Minimal current-working-tree source range |
| `codeatlas_health` | Architecture and technical-debt signals |

Useful first questions include “Give me the repository architecture overview”, “How does checkout
work?”, and “What is affected if I change `PaymentService`?”. The host model explains the result;
CodeAtlas supplies the facts and evidence.

## Supported syntax

| Configuration switch | Parsed syntax |
|---|---|
| `typescript` | TypeScript and TSX |
| `javascript` | JavaScript and JSX |
| `python` | Python |

Each adapter emits 1-based source lines, 0-based columns, deterministic IDs, AST provenance,
confidence, and evidence metadata. Python exports inferred from public-name conventions are
explicitly marked `heuristic` with lower confidence; `__all__` exports are deterministic AST
facts.

## Supported frameworks

| Framework | Extraction |
|---|---|
| Express | Application/router HTTP calls and local handler relationships |
| Fastify | Shorthand HTTP methods and `route({ method, url, handler })` registrations |
| FastAPI | Decorated application/router routes and handler relationships |
| Prisma | Schema models, fields, and local model references |
| SQLAlchemy | Declarative mapped classes, mapped fields, and local model relationships |

Framework analysis is deterministic and optional. Route and database-table string literals are
used transiently for extraction but are persisted only as hashes; route methods, handler/model
identifiers, evidence locations, and structural relationships remain queryable.

## Configuration

`.codeatlas/config.json` is created with:

```json
{
  "version": 1,
  "languages": {
    "typescript": true,
    "javascript": true,
    "python": true
  },
  "analysis": {
    "gitHistory": true,
    "technicalDebt": true,
    "featureDetection": true,
    "frameworks": true,
    "featureOverrides": []
  },
  "limits": {
    "maxTraversalDepth": 10,
    "maxSourceSnippetLines": 120,
    "maxSourceSnippetBytes": 8000,
    "maxMcpResultNodes": 200,
    "maxExecutionPaths": 20,
    "maxInvalidationFiles": 2000,
    "largeFileLines": 500,
    "largeSymbolLines": 80,
    "highFanIn": 10,
    "highFanOut": 10
  }
}
```

Unknown keys, missing keys, invalid JSON, and invalid value ranges fail with a diagnostic.

Manual feature membership uses ordered override entries. `include` and `exclude` accept
repository-relative `*`, `**`, and `?` patterns; matching files are removed from automatic feature
membership and assigned to the configured feature with explicit `config` evidence:

```json
{
  "name": "Billing",
  "include": ["src/payments/**"],
  "exclude": ["src/payments/fixtures/**"],
  "confidence": 1
}
```

## Ignore and secret rules

CodeAtlas combines root and nested `.gitignore` files with `.codeatlasignore`. It always
excludes common generated/vendor directories, `.codeatlas/`, and secret-bearing paths such as
`.env*`, private-key formats, SSH private-key names, and `credentials.*`.

Symlinks resolving outside the repository root are skipped. There is no override for secret
paths in this foundation, which keeps the safe behavior unambiguous.

## Freshness

The stored fingerprint follows the specification exactly:

```text
sha256(
  HEAD + "|" +
  sha256(Git index entries) + "|" +
  sha256(sorted tracked "path:content_hash" entries) + "|" +
  sha256(sorted untracked "path:content_hash" entries)
)
```

Tracked deletions receive an explicit deletion marker. Untracked files respect Git ignore
rules plus CodeAtlas exclusions. This covers HEAD, staged, unstaged, untracked, renamed, and
deleted state, including tracked files marked assume-unchanged. `codeatlas status` performs the
full reconciliation. Long-lived MCP processes invalidate a watched cache immediately on filesystem
events and perform an authoritative reconciliation at least every 30 seconds, so repeated unchanged
requests normally avoid Git while missed watcher events remain bounded.

`codeatlas index` classifies Git state, verifies file hashes, and recomputes the required reverse
dependency neighborhood. A bounded invalidation that reaches its depth/file cap safely falls back
to full reconciliation rather than committing an incomplete graph. Structural, semantic, and FTS
facts advance one generation in a single SQLite transaction; architecture is then computed outside
that write lock and atomically materialized at the same generation. If the process stops between
those commits, status reports a usable partial generation and an architecture request repairs only
the stale derived layer.

## Architecture analysis

Feature and domain nodes are multi-signal groupings with explicit confidence, supporting evidence,
and optional configuration overrides. Dependency communities use deterministic multilevel Louvain
local moving and graph aggregation over analyzable source/model files. Technical-debt
signals include circular dependencies, configurable high fan-in/fan-out thresholds, configurable
large file/symbol thresholds, and files combining elevated recent churn with connectivity.

These are signals rather than quality judgments. Git history collection is optional, bounded to a
90-day/500-commit window, and stores aggregate churn/commit/contributor counts plus the most recent
commit hash/date. Commit diffs and contributor identities are not persisted.

## Architecture

Modules remain one-directional:

```text
CLI → Indexer → Core / Git / Graph / Storage
              ↘ Tree-sitter language adapters
              ↘ Optional framework adapters
MCP → Freshness gate → Graph query contracts
```

- `src/cli`: command presentation and process behavior
- `src/core`: configuration, discovery, hashing, ignores, workspace, freshness
- `src/git`: Git process boundary and repository identity
- `src/graph`: normalized graph contracts and deterministic IDs
- `src/storage`: SQLite lifecycle, migrations, repositories, and FTS search
- `src/indexer`: orchestration and transactional graph writes
- `src/parser`: normalized parser contract, adapter registry, and Tree-sitter implementations
- `src/framework`: optional detection and semantic extraction kept separate from language parsing
- `src/analysis`: grouping, communities, cycles, coupling, churn, and architecture orchestration
- `src/mcp`: provider-independent schemas, freshness gate, packets, and stdio server

Parser code will not depend on MCP. MCP tools will not parse source. Graph/storage entities do
not contain Tree-sitter-specific objects.

Framework adapters implement the public `FrameworkAdapter` contract and can be registered with
`registerFrameworkAdapter` without editing parser or graph-engine code. Adapter exceptions are
isolated to the affected file, recorded for `codeatlas doctor`, and fall back to generic AST facts.

## Privacy

CodeAtlas has no cloud account, remote database, telemetry, API key, or network upload path.
It does not call an LLM. MCP source-evidence responses may be sent elsewhere by the user's
configured MCP host/model; that is separate from CodeAtlas itself, and snippets are labeled as
untrusted repository content.

## Troubleshooting

Run `codeatlas doctor`. If the database is corrupt or its schema/indexer version becomes
incompatible, rebuild with `codeatlas index --full`. A malformed configuration must be fixed;
CodeAtlas will not discard it and fall back to defaults.

If `codeatlas` is not found after a global install, inspect npm's global binary directory with
`npm prefix --global`, ensure that directory is on `PATH`, and restart the MCP host. If native
dependency installation fails, confirm that Node.js 22.12 or newer and a supported operating system
are in use, then retry from a clean npm cache.

## Project status

All eight revised implementation phases and the MVP acceptance contract are complete. Possible
post-MVP distribution work includes Homebrew, standalone binaries, and Windows package-manager
support; npm remains the primary distribution.

See [CONTRIBUTING.md](CONTRIBUTING.md), [RELEASING.md](RELEASING.md),
[SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md).
