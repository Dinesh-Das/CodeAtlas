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
- Deterministic repository, directory, file, and `CONTAINS` graph entities with provenance.
- Tree-sitter adapters for TypeScript, JavaScript, TSX, JSX, and Python.
- Evidence-bearing module, class, interface, function, method, and variable nodes.
- Deterministic `CONTAINS`, `EXPORTS`, `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`, and
  `REFERENCES` relationships.
- Explicit unresolved and multi-candidate resolution records; ambiguous edges use confidence
  scaled by import-graph distance.
- Literal-safe signatures that redact assigned/default string values before persistence.
- Transactional structural indexing, deleted-file cleanup, status checks, and a single-writer
  workspace lock.
- Git-derived added/modified/deleted/renamed change classification backed by authoritative file
  hashes, including dirty and committed changes.
- Reverse dependency-neighborhood invalidation so changed targets re-resolve their callers without
  reparsing unrelated files.
- Identity-preserving Git renames at 50% or greater similarity, recorded with `RENAMED_FROM`
  provenance edges; lower-similarity moves remain delete plus create.
- Optional, separately registered framework adapters for Express, FastAPI, Prisma, and SQLAlchemy.
- Evidence-bearing `api_route` and `database_model` nodes with `EXPOSES`, `HANDLES`,
  `CONTAINS`, and `REFERENCES` relationships.
- Deterministic feature/domain grouping and dependency communities derived from the current graph.
- Persisted fan-in, fan-out, dependency depth, cross-domain coupling, size, and bounded Git-history
  metrics.
- Evidence-bearing cycle, high-coupling, large-symbol/file, and churn/connectivity hotspot signals.
- Meaningful, paginated `codeatlas_overview` and `codeatlas_health` MCP responses.
- Graph-backed status, search, node detail, feature explanation, execution trace, impact,
  dependency-neighborhood, and current-source MCP responses.
- Bounded traversal, definite-versus-potential impact classification, opaque query-bound cursors,
  ambiguity reporting, and stable node IDs for follow-up queries.
- Current-working-tree source excerpts capped by configuration, path-contained within the
  repository, and labeled `untrusted_repository_content`.
- Official-SDK MCP stdio server with all ten required tools, validated inputs, typed Answer
  Packets, configured limits, and a mandatory freshness gate before every tool call.
- Parser and call-graph snapshots plus unit, integration, compiled-CLI, and MCP protocol tests
  using disposable Git repositories.

All ten required MCP tools return grounded Answer Packets. Structural facts and relationships
carry confidence and file/line evidence; unresolved or ambiguous queries explicitly report an
uncertainty rather than selecting a candidate silently.

## Requirements

- Node.js 24 LTS or newer
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
`untrusted_repository_content`.

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
    "frameworks": true
  },
  "limits": {
    "maxTraversalDepth": 10,
    "maxSourceSnippetLines": 120,
    "maxMcpResultNodes": 200,
    "maxExecutionPaths": 20,
    "largeFileLines": 500,
    "largeSymbolLines": 80,
    "highFanIn": 10,
    "highFanOut": 10
  }
}
```

Unknown keys, missing keys, invalid JSON, and invalid value ranges fail with a diagnostic.

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
  sha256(sorted tracked "path:content_hash" entries) + "|" +
  sha256(sorted untracked "path:content_hash" entries)
)
```

Tracked deletions receive an explicit deletion marker. Untracked files respect Git ignore
rules plus CodeAtlas exclusions. `codeatlas status` recomputes this value from the current
working tree; `codeatlas index` classifies Git state, verifies file hashes, recomputes only the
required dependency neighborhood, and updates the database and fingerprint in one SQLite
transaction. When the graph changes, feature/domain memberships and graph-only architecture
metrics are recomputed in that same transaction without reparsing unrelated files.

## Architecture analysis

Feature and domain nodes are heuristic groupings with explicit confidence and evidence. Dependency
communities are deterministic connected components of analyzable source/model files. Technical-debt
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
dependency installation fails, confirm that Node.js 24 and a supported current operating system
are in use, then retry from a clean npm cache.

## Project status

All eight revised implementation phases and the MVP acceptance contract are complete. Possible
post-MVP distribution work includes Homebrew, standalone binaries, and Windows package-manager
support; npm remains the primary distribution.

See [CONTRIBUTING.md](CONTRIBUTING.md), [RELEASING.md](RELEASING.md),
[SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md).
