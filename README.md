# CodeAtlas

[![npm version](https://img.shields.io/npm/v/@dinesh-das/codeatlas?label=npm&color=cb3837)](https://www.npmjs.com/package/@dinesh-das/codeatlas)
[![npm downloads](https://img.shields.io/npm/dm/@dinesh-das/codeatlas?color=cb3837)](https://www.npmjs.com/package/@dinesh-das/codeatlas)
[![CI](https://github.com/Dinesh-Das/CodeAtlas/actions/workflows/ci.yml/badge.svg)](https://github.com/Dinesh-Das/CodeAtlas/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/@dinesh-das/codeatlas)](https://www.npmjs.com/package/@dinesh-das/codeatlas)
[![License](https://img.shields.io/github/license/Dinesh-Das/CodeAtlas)](LICENSE)

CodeAtlas is a local, evidence-first code intelligence tool for developers and AI coding agents.
It compiles a repository into a versioned architecture graph, creates an offline interactive view,
and exposes bounded graph queries over MCP.

Every relationship carries provenance, confidence, and source evidence. Results distinguish what
was verified, inferred, detected as dynamic, or left unresolved instead of silently turning a
guess into a fact.

```bash
npm install --global @dinesh-das/codeatlas
cd /path/to/project
codeatlas build .
```

Open `codeatlas.html` for the interactive architecture view, or run:

```bash
codeatlas overview
codeatlas setup
```

`setup` configures a detected Codex, Claude Code, Cursor, or Antigravity client to start the local
CodeAtlas MCP server.

## What CodeAtlas produces

`codeatlas build` initializes or refreshes the local index and generates all projections from the
same canonical IR:

```text
project/
├── codeatlas.html              # self-contained offline application (default)
├── CODEATLAS.md                # compact human/agent overview
├── CODEATLAS.mmd               # Mermaid architecture diagram
└── .codeatlas/
    ├── atlas.db                # local SQLite graph and search index
    ├── config.json             # local analysis and query limits
    ├── current/                # canonical IR plus JSON/JSONL projections
    ├── snapshots/              # retained architecture snapshots
    └── agent/                  # compact agent context and manifest
```

Use `codeatlas build --bundle` to generate `codeatlas/index.html` and sharded files under
`codeatlas/data/` instead of the single-file application. `--single-file` overrides a configured
bundle mode. CodeAtlas excludes these generated paths from its own analysis; add the root export
paths to the target repository's `.gitignore` if they should not be committed (this repository
already does so).

The viewer includes repository, domain, entrypoint, execution-flow, file/class, function,
control-flow, impact, Git-change, rule, review, and evidence views. Diagrams are interactive SVG
and can be exported as SVG.

The flat `current/` projection contains `atlas.json`, `symbols.jsonl`, `relationships.jsonl`,
`flows.jsonl`, `domains.json`, `impact.json`, `evidence.json`, `resolution-issues.json`,
`rules.json`, `review.json`, `manifest.json`, and build metadata. Bundle mode additionally shards
symbols, relationships, flows, control-flow graphs, evidence, resolution issues, and Git changes
under `codeatlas/data/`.

## How it works

```text
working tree
    ↓
Tree-sitter + TypeScript compiler + framework adapters
    ↓
SQLite structural/semantic/search index
    ↓
canonical IR 1.2 (evidence, uncertainty, flows, impact, rules, snapshots)
    ↓
offline HTML / Markdown / Mermaid / MCP
```

CodeAtlas currently provides:

- TypeScript, TSX, JavaScript, JSX, and Python parsing.
- Project-aware TypeScript/JavaScript module resolution, including `tsconfig`/`jsconfig`, package
  exports, path aliases, and workspace packages.
- `CONTAINS`, `EXPORTS`, `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`, and `REFERENCES`
  relationships with stable IDs and evidence.
- Explicit unresolved, ambiguous, dynamic, generated-code, and unsupported-framework diagnostics.
- Express, Fastify, FastAPI, Prisma, and SQLAlchemy framework extraction.
- Deterministic domains, features, dependency communities, architecture metrics, and rules.
- Branch-preserving execution flows and structured control-flow graphs for supported constructs.
- Git-aware changes, rename preservation, impact paths, snapshots, and deterministic review findings.
- FTS/BM25, exact-name, path, package, architecture, and graph-neighborhood retrieval.
- Incremental indexing with generation tracking and authoritative freshness checks before MCP reads.

The public package also exports `buildRepository`, rendering helpers, `createCodeAtlasServer`,
`registerCodeAtlasLanguage`, and `registerFrameworkAdapter` for programmatic integrations.

## Trust model

CodeAtlas keeps target resolution separate from runtime execution semantics:

- `verified`: deterministic syntax, compiler, framework, schema, or configuration evidence.
- `inferred`: a bounded heuristic with reduced confidence and visible provenance.
- `dynamic`: runtime behavior exists but cannot be statically proven.
- `unresolved`: the target could not be selected safely; candidates and the reason are retained.

Canonical IR 1.2 adds scoped file/range hashes, excerpt status, first-class resolution issues,
relationship uncertainty, and CFG capability metadata. Persistent IR 1.0 and 1.1 snapshots are
upgraded in memory without rewriting the stored snapshot. See
[canonical IR compatibility](docs/canonical-ir-compatibility.md).

Repository source, comments, and documentation are always treated as untrusted input. Bounded
source excerpts are read from the synchronized working tree and labeled
`untrusted_repository_content`.

## Requirements and installation

- Node.js 22.12 or newer
- npm
- Git recommended, but not required for basic filesystem-mode indexing

```bash
npm install --global @dinesh-das/codeatlas
codeatlas --version
```

The unscoped npm name `codeatlas` belongs to another package. Install the scoped package shown
above; the executable is still named `codeatlas`.

Git repositories receive commit-aware fingerprints, history, changes, renames, and commit-backed
snapshots. Outside Git, CodeAtlas indexes the selected directory in filesystem mode; Git history,
base/head diffs, and rename provenance are unavailable.

No Docker container, cloud account, API key, or external database is required.

## CLI reference

All optional `[path]` arguments default to the current directory.

| Command | Purpose |
|---|---|
| `codeatlas build [path]` | Refresh the index and generate IR, HTML, Markdown, Mermaid, agent context, and a snapshot |
| `codeatlas build --full` | Force a complete structural rebuild |
| `codeatlas build --bundle` | Generate the sharded HTML bundle |
| `codeatlas build --single-file` | Force the self-contained HTML output |
| `codeatlas build --no-snapshot` | Build without persisting a snapshot |
| `codeatlas update [path]` | Incrementally regenerate all architecture artifacts |
| `codeatlas watch [path]` | Poll for changes and regenerate; minimum interval is 250 ms |
| `codeatlas context "<task>" [path]` | Compile a budgeted implementation brief with candidates, impact paths, tests, constraints, evidence, and gaps |
| `codeatlas ask "<question>" [path]` | Answer locally from graph facts and validated evidence |
| `codeatlas search <query> [path]` | Search the canonical graph |
| `codeatlas symbol <id> [path]` | Resolve an exact ID, qualified name, or unique search term |
| `codeatlas impact <symbol> [path]` | Calculate reverse dependency paths and impact |
| `codeatlas diff [path] --base <ref> --head <ref>` | Map a Git diff to symbols and impact |
| `codeatlas check [path]` | Evaluate architecture rules and fail on error-severity violations |
| `codeatlas review [path] --base <ref> --head <ref>` | Produce deterministic, evidence-gated review findings |
| `codeatlas snapshot list [path]` | List retained snapshots |
| `codeatlas snapshot show <id> [path]` | Print one snapshot |
| `codeatlas snapshot diff <old> <new> [path]` | Compare two snapshots |
| `codeatlas snapshot prune [path] --keep <count>` | Remove snapshots beyond the retention count |
| `codeatlas init [path]` | Create the workspace and initial index |
| `codeatlas overview [path]` | Print architecture, entrypoints, and hotspots without MCP |
| `codeatlas setup [path]` | Configure detected MCP clients |
| `codeatlas index [path]` | Synchronize the local graph incrementally |
| `codeatlas status [path]` | Compare the working tree with the indexed fingerprint |
| `codeatlas doctor [path]` | Check configuration, runtime, parsers, storage, and graph health |
| `codeatlas mcp [path]` | Start the MCP server over stdio |
| `codeatlas clean [path]` | Remove `.codeatlas/` after confirmation |

Machine-readable output is available from `build`, `update`, `ask`, `diff`, `check`, `review`,
`index`, `overview`, and `status` with `--json`. Query limits are available through
`search --limit`, `impact --depth/--limit`, and `watch --interval`. Use `init --shared-ignore` only
when the team deliberately wants `.codeatlas/` added to the tracked `.gitignore`.

## MCP setup and tools

Automatic setup is the shortest path:

```bash
codeatlas build .
codeatlas setup
```

Use `--target cursor,codex` to choose clients, `--all` to configure every supported format, or
`--dry-run` to preview destinations. Unrelated servers are preserved and a conflicting
`codeatlas` entry is not overwritten.

For any other MCP-compatible host, configure a local stdio server:

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

See the copyable [MCP configuration example](examples/mcp-config.json).

The default server exposes four compact, read-only tools:

| Area | Tools |
|---|---|
| Discovery | `search` |
| Task context | `prepare_change` |
| Execution and dependencies | `trace` |
| Source proof | `get_evidence` |

Clients can progressively read `codeatlas://repository/overview`, `codeatlas://symbol/{id}`,
`codeatlas://tour/{id}`, and `codeatlas://change/{fingerprint}`. Reusable prompts cover repository
onboarding, change planning, diff review, and runtime-journey explanation.

Responses use validated schemas, stable IDs, opaque cursors, serialized-size limits, and a common
`codeatlas` envelope containing schema/snapshot provenance, fingerprint, generations, freshness,
content trust, coverage, and uncertainty counts. Expected failures use typed, recoverable error
packets with a suggested next action. Ambiguous symbol names must be followed with the stable ID
returned by `search`.

Set `CODEATLAS_MCP_LEGACY_TOOLS=1` during the 0.x compatibility window to expose the previous
Answer Packet and canonical tool names alongside the four primary tools.

MCP requests use watcher-backed freshness metadata and periodically reconcile the working tree.
Invalidated caches incrementally repair the required structural, semantic, search, or architecture
generation before answering.

## Configuration

CodeAtlas uses two deliberately separate configuration files:

- `.codeatlas/config.json` is local runtime configuration created by `init` or `build`.
- `.codeatlas.yml` is optional, tracked team configuration for exclusions, named domains,
  architecture rules, analysis depth, HTML mode, and the reserved AI flag.

Both formats are strict: unknown keys and invalid values fail with a diagnostic instead of being
silently ignored.

The generated local configuration defaults to all three languages and framework analysis enabled,
bounded source/query/traversal limits, 20 retained snapshots, and relationship-quality thresholds.
Run `codeatlas doctor` after editing it.

A minimal tracked configuration looks like this:

```yaml
version: 1

index:
  exclude:
    - fixtures/**

domains:
  billing:
    include:
      - src/billing/**
    exclude:
      - src/billing/test-data/**

architecture:
  rules:
    - id: core-is-independent
      severity: error
      description: Core must not depend on the MCP layer.
      source:
        matches_path: src/core/
      forbid:
        depends_on:
          matches_path: src/mcp/

analysis:
  max_call_depth: 8
  max_impact_depth: 10

html:
  mode: single-file
  max_single_file_bytes: 10485760

ai:
  enabled: false
```

Rule selectors support `kind`, `layer`, `domain`, and `matches_path`. Predicates include direct
`depends_on`, `calls`, and `imports`; bounded `path_to` with `unless_via`; `belongs_to`; and
`crosses_domain`.

`CODEATLAS_HTML_MODE`, `CODEATLAS_MAX_CALL_DEPTH`, `CODEATLAS_MAX_IMPACT_DEPTH`, and
`CODEATLAS_AI_ENABLED` can override their tracked equivalents for a process. The AI flag is
reserved: the current codebase has no built-in model provider, so enabling it does not make a
network request.

CodeAtlas switches to the sharded bundle automatically when the estimated self-contained viewer
would exceed `html.max_single_file_bytes`. Pass `--single-file` to explicitly request the full
self-contained export.

## Supported languages and frameworks

| Language switch | Syntax |
|---|---|
| `typescript` | TypeScript and TSX |
| `javascript` | JavaScript and JSX |
| `python` | Python |

Source-language adapters own structural extraction and syntax-tree creation so downstream CFG
analysis does not maintain a second grammar switch. Third-party adapters can be registered with
`registerCodeAtlasLanguage(...)`.

| Framework | Current extraction |
|---|---|
| Express | Application/router routes and local handlers |
| Fastify | Routes, plugins, prefixes, hooks, protection, handlers, and conditional continuation |
| FastAPI | Decorated application/router routes and handlers |
| Prisma | Schema models, fields, references, and verified client query/update operations |
| SQLAlchemy | Declarative models, mapped fields, and local model relationships |

Framework adapters are optional and can be extended through `registerFrameworkAdapter(...)`.
Route and database-table literals are used transiently during extraction and stored as hashes;
exact values are re-read from synchronized evidence ranges when requested.

## Freshness, storage, and privacy

CodeAtlas fingerprints the checked-out commit (when present), Git index, tracked content, and
untracked content after ignore rules. Staged, unstaged, renamed, deleted, and untracked changes are
therefore visible. Filesystem mode uses a content fingerprint without Git metadata.

Incremental indexing reparses changed files and re-resolves a bounded reverse-dependency
neighborhood. If the invalidation boundary cannot be proven complete, CodeAtlas falls back to full
reconciliation. Structural, semantic, and search generations advance atomically; architecture is
materialized separately with the generation it was derived from and repaired on demand when stale.

The SQLite database stores structural metadata, hashes, and bounded derived facts, not complete
source files or plaintext string literal values. CodeAtlas combines `.gitignore`, nested
`.gitignore`, `.codeatlasignore`, `.codeatlas.yml` exclusions, generated/vendor defaults, and
secret-path rules. Symlinks or junctions that resolve outside the repository root are skipped.

Indexing, exports, snapshots, rules, review, local `ask`, and MCP transport run locally. CodeAtlas
has no telemetry upload, cloud database, or built-in model-provider transport. MCP hosts may send
returned context to their configured model provider; that behavior is controlled by the host and is
outside CodeAtlas.

Generated HTML, IR, snapshots, and agent context can contain bounded source excerpts. Protect them
with the same confidentiality as the source repository. See the [security policy](SECURITY.md).

## Architecture

```text
CLI ─┬─> compiler ─> IR ─> exports
     └─> indexer ──> storage

MCP ─> freshness/service ─> IR queries

parser/framework ─> graph ─> analysis/rules/review
core/git ────────────────────┘
```

The main source boundaries are:

- `src/core`, `src/git`, `src/storage`, and `src/indexer`: discovery, state, persistence, and
  synchronization.
- `src/parser`, `src/framework`, and `src/graph`: language/framework extraction and relationship
  resolution.
- `src/analysis`, `src/rules`, and `src/review`: architecture, flows, impact, policy, and findings.
- `src/ir`, `src/compiler`, and `src/export`: canonical model, build orchestration, and projections.
- `src/cli`, `src/mcp`, and `src/service`: user and agent interfaces over the same indexed facts.

## Development

```bash
npm ci
npm run check
npm run package:smoke
```

`npm run check` builds and runs type checking, linting, and the complete test suite. The package
smoke test packs the publishable artifact, installs it into a disposable Git repository, and
exercises the installed CLI and public API. Release metadata changes should also pass the
appropriate gate documented in [RELEASING.md](RELEASING.md).

For a local CLI:

```bash
npm run build
npm link
codeatlas --version
```

The generated 100k–1M LOC benchmark profiles are available through `npm run benchmark` and
`npm run benchmark:full`. Use `npm run benchmark:real -- --repository /absolute/path` for the
detached-worktree real-repository benchmark. Results depend on repository shape and hardware.

## Troubleshooting

Run `codeatlas doctor` first. If storage is corrupt or incompatible, rebuild with
`codeatlas index --full`. Invalid configuration must be fixed; CodeAtlas does not discard it and
continue with defaults.

If `codeatlas` is missing after a global install, inspect npm's global prefix with
`npm prefix --global`, ensure its binary directory is on `PATH`, and restart the MCP host. Native
dependency installation requires a supported Node.js runtime and platform toolchain.

## Project documentation

- [Changelog](CHANGELOG.md)
- [Roadmap](ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Release process](RELEASING.md)
- [Security policy](SECURITY.md)
- [Canonical IR compatibility](docs/canonical-ir-compatibility.md)

The package version is `0.10.0`; work recorded under **Unreleased** in the changelog is present in
the current working tree but is not part of that tagged release until published through the release
workflow.
