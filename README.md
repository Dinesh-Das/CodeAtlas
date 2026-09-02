# CodeAtlas

[![npm version](https://img.shields.io/npm/v/@dinesh-das/codeatlas?label=npm&color=cb3837)](https://www.npmjs.com/package/@dinesh-das/codeatlas)
[![npm downloads](https://img.shields.io/npm/dm/@dinesh-das/codeatlas?color=cb3837)](https://www.npmjs.com/package/@dinesh-das/codeatlas)
[![CI](https://github.com/Dinesh-Das/CodeAtlas/actions/workflows/ci.yml/badge.svg)](https://github.com/Dinesh-Das/CodeAtlas/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/@dinesh-das/codeatlas)](https://www.npmjs.com/package/@dinesh-das/codeatlas)
[![License](https://img.shields.io/github/license/Dinesh-Das/CodeAtlas)](https://github.com/Dinesh-Das/CodeAtlas/blob/main/LICENSE)

[npm package](https://www.npmjs.com/package/@dinesh-das/codeatlas) ·
[source code](https://github.com/Dinesh-Das/CodeAtlas) ·
[releases](https://github.com/Dinesh-Das/CodeAtlas/releases) ·
[changelog](https://github.com/Dinesh-Das/CodeAtlas/blob/main/CHANGELOG.md) ·
[issues](https://github.com/Dinesh-Das/CodeAtlas/issues)

**Give your AI coding agent a verified, continuously updated map of your codebase.**

CodeAtlas traces architecture, execution, APIs, and data access—and labels every answer as
verified, inferred, dynamic, or unresolved. It runs locally, follows the working tree, and returns
file/line evidence instead of asking you to trust a black box.

CodeAtlas also acts as a repository architecture compiler. One command creates a portable,
self-contained architecture application for developers and a canonical evidence-linked IR for
agents:

```bash
codeatlas build .
```

Generated outputs include `codeatlas.html`, `CODEATLAS.md`, `CODEATLAS.mmd`, `.codeatlas/current/atlas.json`,
JSONL symbol/relationship/flow streams, compact agent context, and a persistent architecture
snapshot. The HTML opens directly from disk, embeds its graph as compressed data, and has no CDN or
network dependency. Its architecture, sequence, and control-flow diagrams are interactive SVG and
can be exported as standalone SVG. It is a view of the same versioned IR queried by MCP—not a
separate analysis pipeline.

- Trace requests end to end.
- Understand an unfamiliar architecture.
- Find the blast radius before changing code.
- See exactly what is known, inferred, or unresolved.
- Keep source code on your machine.

```bash
npm install --global @dinesh-das/codeatlas
codeatlas init
codeatlas setup
```

Get value before configuring an agent:

```bash
codeatlas overview
```

```text
How does account reset work?

DELETE /account/reset-module
  ├─ PROTECTED_BY authorize                         VERIFIED
  │    └─ IMPLEMENTED_BY handleAuth                 VERIFIED
  │         └─ MAY_CONTINUE_TO route                CONDITIONAL
  └─ HANDLES deleteResetModule                      VERIFIED
       ├─ QUERIES user                              VERIFIED · Prisma
       └─ UPDATES user                              VERIFIED · Prisma

Evidence: source files, lines, provenance, confidence, and unresolved candidates
```

## Why CodeAtlas

Grep finds matching text. Embedding search finds similar text. CodeAtlas answers a different
question: **what relationships can the repository actually support with evidence?**

```text
working tree
    ↓
incremental Tree-sitter + TypeScript compiler + framework analysis
    ↓
evidence graph (verified / inferred / dynamic / unresolved)
    ↓
bounded search, traces, impact, architecture, and source packets
    ↓
your coding agent explains the evidence
```

Semantic similarity may eventually help retrieve candidates, but it never turns similarity into a
claimed relationship. The graph/compiler/framework layers validate relationships first.

## Measured on a large repository

The reproducible real-repository benchmark indexed freeCodeCamp commit
`6d0d89755eb233631adfdb5d44596339c5bbe97b` (19,423 tracked files and 220,775
tracked JS/TS LOC) on Windows x64 with Node.js 24.12.0. The resulting graph contained 159,329
nodes, 229,885 relationships, 119 API routes, and 10 parser failures:

| Scenario | Result |
|---|---:|
| Cold/full index | 405.40 s |
| No-change freshness/index command | 1.88 s |
| Comment-only file | 3.02 s |
| One implementation file | 5.35 s |
| Exported symbol change | 13.56 s |
| Raw search packet p95 | 42.46 ms |
| Raw trace packet p95 | 11.57 ms |
| Raw impact packet p95 | 172.63 ms |
| Freshness gate p95 | 2,479.07 ms |
| External peak RSS | 4.20 GiB |
| SQLite database | 700.70 MiB |

Results are hardware- and repository-dependent. Reproduce them with
`npm run benchmark:real -- --repository PATH`; generated 100k–1M LOC profiles are also included.
The raw packet rows run against an already-open graph context and exclude freshness checks, MCP
transport, the coding-agent host, and model latency. The freshness row measures the separate
working-tree synchronization gate. This benchmark is release evidence, not a promise
that every repository has the same shape or compiler cost.

## Trust model

- `VERIFIED`: deterministic AST, compiler, framework, schema, or configuration evidence.
- `INFERRED`: a bounded heuristic with reduced confidence and visible provenance.
- `DYNAMIC`: runtime behavior was detected but cannot be statically proven.
- `UNRESOLVED`: CodeAtlas records the gap instead of silently choosing a target.

Source snippets are read from the current working tree, bounded by configuration, and labeled as
untrusted repository content. CodeAtlas does not expose or require a model's private chain of
thought; it gives the model—and you—the evidence needed to evaluate the answer.

## What ships

- TypeScript/Node.js CLI with `init`, `overview`, `setup`, `index`, `status`, `doctor`, and safe
  `clean` commands.
- Git-root detection with an explicit V1 error for non-Git directories.
- Local `.codeatlas/` workspace creation with a default Git `info/exclude` rule; tracked
  `.gitignore` changes require the explicit `init --shared-ignore` option.
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
- Project-aware TypeScript resolution through the target repository's compatible compiler (with a
  visible bundled fallback), including `tsconfig`/`jsconfig`
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
- Fastify plugin-parameter propagation, nested and inline registrations, inline handler nodes,
  inherited prefixes/hooks, `preValidation`, and conditional hook-to-handler continuation.
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

CI verifies the project on Linux, macOS, and Windows. Release tags repeat the complete Node 22/24
matrix, package installation smoke tests, coverage gate, dependency audit, and CodeQL analysis
before the OIDC publisher can run.

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
codeatlas build .
```

Open `codeatlas.html` to explore repository → domain → entrypoint/flow → file/class → function/CFG
levels, impact paths, Git changes, rules, and evidence. Run `codeatlas setup` when you also want to
configure a supported coding agent for MCP. The existing `init`/`index` workflow remains supported
for compatibility.

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
codeatlas build [path]            Compile IR, HTML, agent context, and a snapshot
codeatlas build --bundle          Also create codeatlas/index.html plus codeatlas/data/
codeatlas update [path]           Incrementally regenerate all architecture artifacts
codeatlas watch [path]            Regenerate on changes without an IDE extension or server
codeatlas search <query>          Search the complete canonical graph
codeatlas symbol <id>             Show one canonical symbol
codeatlas impact <symbol>         Explain impact with paths and evidence
codeatlas diff --base <ref>       Map Git hunks to symbols and architectural impact
codeatlas check [path]            Evaluate rules; fail for error-severity violations
codeatlas review --base <ref>     Produce deterministic evidence-gated review findings
codeatlas ask "<question>"        Answer locally from graph facts and evidence
codeatlas snapshot list           List persistent architecture states
codeatlas snapshot show <id>      Show one canonical snapshot
codeatlas snapshot diff <a> <b>   Compare two architecture snapshots
codeatlas snapshot prune --keep 20 Remove snapshots beyond the retention limit
codeatlas init [path]             Create the workspace and initial structural graph
codeatlas init --shared-ignore    Deliberately add .codeatlas/ to tracked .gitignore
codeatlas overview [path]         Print architecture, entrypoints, and hotspots directly
codeatlas overview --json         Emit a machine-readable architecture summary
codeatlas setup [path]            Configure detected Codex/Claude/Cursor/Antigravity clients
codeatlas setup --all --dry-run   Preview every supported MCP configuration destination
codeatlas index [path]            Synchronize changes and dependency neighborhoods
codeatlas index --full [path]     Rebuild the structural graph transactionally
codeatlas index --quiet           Suppress progress output
codeatlas index --json            Emit a machine-readable result (progress stays on stderr)
codeatlas status [path]           Compare the working tree with the stored fingerprint
codeatlas status --json           Return machine-readable status
codeatlas doctor [path]           Check runtime, compiler, parsers, Git, storage, and graph health
codeatlas clean [path]            Remove the local index after confirmation
codeatlas clean --force           Remove it non-interactively
codeatlas mcp [path]              Start the CodeAtlas MCP server over stdio
```

## Local workspace

`codeatlas init` creates only local, ignored state:

```text
.codeatlas/
├── atlas.db
├── config.json
├── manifest.json
├── state.json
├── current/
│   ├── atlas.json
│   ├── symbols.jsonl
│   ├── relationships.jsonl
│   ├── flows.jsonl
│   ├── domains.json
│   ├── impact.json
│   ├── evidence.json
│   ├── rules.json
│   └── review.json
├── snapshots/<commit-or-worktree-id>/atlas.json
├── agent/overview.md
├── cache/
└── logs/
```

By default, `.codeatlas/` is written to Git's local `info/exclude`, leaving tracked files
untouched. Use `codeatlas init --shared-ignore` only when the team deliberately wants the rule in
`.gitignore`. The `lock` file exists only while an index writer owns the workspace.

The database stores structural metadata and hashes, not complete source files or string literal
values. Import module values used during resolution remain transient; unresolved import records
store only a SHA-256 hash. Source contents remain in the working tree.

## MCP setup

The fastest path is automatic setup:

```bash
codeatlas setup
```

CodeAtlas detects Codex, Claude Code, Cursor, and Antigravity. Use `--target cursor,codex` to pick
clients, `--all` to configure all supported formats, or `--dry-run` to inspect destinations first.
Existing unrelated MCP servers are preserved, and a conflicting `codeatlas` entry is never
silently overwritten.

To configure another MCP-compatible host manually, launch `codeatlas mcp` with the repository as
its working directory or pass the repository path explicitly:

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

The server uses stdio and writes no protocol-breaking output to stdout. Every tool request passes
through the freshness gate, authoritatively checks Git state, and performs an incremental index
update when needed. The Answer Packet reports `mode`, `working_tree_checked`, the authoritative
check time, request time, cache invalidation state, and the reconciliation-age contract.
All source snippets in the stable Answer Packet contract are labeled
`untrusted_repository_content`. Empty or ambiguous results return explicit uncertainty such as
`insufficient_evidence`, `unresolved_reference`, or `dynamic_relationship`; the MCP layer never
manufactures a missing relationship or answer.

The default API is a focused canonical-IR surface: `get_repository_overview`, `find_symbol`,
`get_symbol`, `get_callers`, `get_dependencies`, `trace_path`, `analyze_impact`, `get_domain`,
`list_domains`, `get_entrypoints`, `get_execution_flow`, `get_control_flow`, `get_git_changes`,
`get_rules`, `get_rule_violations`, `get_evidence`, `get_snapshot`, `compare_snapshots`, and
`review_changes`. Results use stable IDs, explicit provenance, and bounded evidence.

The previous 33-tool API remains available for existing clients by setting
`CODEATLAS_MCP_LEGACY_TOOLS=1` on the MCP server process. New integrations should use the default
canonical tools to reduce tool-selection ambiguity and context overhead.

Canonical-IR collection tools use independent opaque cursors and serialized-size limits.
`get_snapshot` returns metadata by default; pass a `section` such as `symbols`, `relationships`,
`evidence`, or `git_changes` with `limit` and `cursor` to retrieve a bounded snapshot section.
Use `get_git_changes` for paginated change records alongside `review_changes` findings.

| Canonical tool | Purpose |
|---|---|
| `get_repository_overview` | Repository, domains, entrypoints, and graph statistics |
| `find_symbol` / `get_symbol` | Ranked architecture-aware discovery and exact symbol context |
| `trace_path` / `get_execution_flow` | Evidence-bearing dependency and multi-branch execution paths |
| `analyze_impact` | Separate definite and potential blast radius with bounded paths |
| `get_dependencies` / `get_callers` | Outgoing and incoming canonical neighborhoods |
| `get_evidence` | Minimal evidence for a symbol or evidence ID |

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
| Fastify | Routes, typed/registered plugin receivers, inline handlers/plugins, nested prefixes, request hooks including `preValidation`, protection, implementations, and conditional continuation |
| FastAPI | Decorated application/router routes and handler relationships |
| Prisma | Schema models/fields/references plus verified client query and update operations |
| SQLAlchemy | Declarative mapped classes, mapped fields, and local model relationships |

Framework analysis is deterministic and optional. Route, prefix, and database-table string
literals are used transiently for extraction but are persisted only as hashes. MCP route lookup
re-reads verified evidence ranges from the synchronized working tree, so exact base and composed
route paths remain answerable without storing plaintext paths.

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
    "highFanOut": 10,
    "maxSnapshots": 20,
    "minimumVerifiedRelationshipPercent": 50,
    "maximumUnresolvedRelationshipPercent": 20
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

Portable compiler views, explicit domains, and architecture rules use an optional tracked
`.codeatlas.yml`. Explicit domains win over inferred grouping:

```yaml
version: 1

index:
  exclude:
    - generated/**
    - fixtures/**

domains:
  authentication:
    include:
      - src/auth/**

architecture:
  rules:
    - id: controllers-must-not-call-repositories
      severity: error
      description: Controllers must use services.
      source:
        layer: controller
      forbid:
        calls:
          layer: repository

analysis:
  max_call_depth: 8
  max_impact_depth: 10

html:
  mode: single-file

ai:
  enabled: false
```

`analysis.max_call_depth` and `analysis.max_impact_depth` are validated in the range 1–100.
`html.mode` accepts only `single-file` or `bundle`. `CODEATLAS_HTML_MODE`,
`CODEATLAS_AI_ENABLED`, `CODEATLAS_MAX_CALL_DEPTH`, and `CODEATLAS_MAX_IMPACT_DEPTH` can override
those non-secret settings for a process. Credentials, API keys, tokens, and provider secrets are
not supported in `.codeatlas.yml`. The current release has no built-in local or remote AI-provider
transport, so setting `ai.enabled: true` is only an explicit opt-in flag for provider functionality
that may be added later; it does not by itself send repository content anywhere.

Rule selectors support `kind`, `layer`, `domain`, and `matches_path`; predicates include direct
`depends_on`, `calls`, and `imports`, bounded `path_to` with `unless_via`, `belongs_to`, and
`crosses_domain`.

## Language and framework adapters

Source-language analysis uses Tree-sitter as the common parser baseline. Built-in adapters cover
TypeScript, TSX, JavaScript, JSX, and Python. Each language adapter owns both structural extraction
and syntax-tree creation, so downstream analyses such as control-flow generation reuse the same
language adapter instead of maintaining a second grammar switch.

The public package API exposes `registerCodeAtlasLanguage(...)` and
`registerFrameworkAdapter(...)`. Both registries reject accidental duplicate registration, support
explicit temporary replacement, and restore the previous adapter when the replacement is removed.
Framework extensions can detect a supported framework and contribute routes, models, supporting
nodes, relationships, and unresolved references without replacing the generic AST analysis.

```ts
import { registerCodeAtlasLanguage, registerFrameworkAdapter } from "@dinesh-das/codeatlas";

const unregister = registerCodeAtlasLanguage({
  language: "my-language",
  extensions: [".mine"],
  adapter: myTreeSitterAdapter,
});
```

Current framework adapters prioritize the repository's existing supported surface: Express,
Fastify, FastAPI, Prisma, and SQLAlchemy. Additional frameworks can be added through the same
contract without changing the compiler pipeline.

## Ignore and secret rules

CodeAtlas combines root and nested `.gitignore` files with `.codeatlasignore` and
`.codeatlas.yml` `index.exclude` patterns. It always
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
full reconciliation. Fast status callers invalidate a watched cache on filesystem events and
perform an authoritative reconciliation at least every 30 seconds. MCP requests always bypass
that watcher cache and verify Git state before answering, avoiding event-delivery races after an
edit. Packets distinguish `authoritative` from `watch_cache`; `working_tree_checked` is true only
for the former, and `authoritative_checked_at` never advances merely because cached state was reused.

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
- `src/ir`: public versioned models, first-class evidence, normalization, serialization, validation,
  and SQLite graph projection
- `src/compiler`: one graph/multiple projections build orchestration
- `src/export`: deterministic JSON/JSONL, compact Markdown, and self-contained offline HTML
- `src/rules` and `src/review`: declarative architecture policy and evidence-gated findings

Parser code will not depend on MCP. MCP tools will not parse source. Graph/storage entities do
not contain Tree-sitter-specific objects.

Framework adapters implement the public `FrameworkAdapter` contract and can be registered with
`registerFrameworkAdapter` without editing parser or graph-engine code. Adapter exceptions are
isolated to the affected file, recorded for `codeatlas doctor`, and fall back to generic AST facts.

## Privacy

CodeAtlas has no cloud account, remote database, external telemetry/analytics, API key, or network
upload path. The internal `IndexTelemetry` instrumentation records timing, cache, and memory metrics
in-process and in local build metadata only; it does not transmit them. Source parsing, graph
generation, HTML export, snapshots, review, `codeatlas ask`, and the CodeAtlas side of MCP all run
locally. MCP uses local stdio transport.

The current release does not call an LLM and has no built-in local or remote AI-provider transport.
`ai.enabled` defaults to `false`; enabling it alone does not create a network path. Any future
provider implementation must remain explicitly opt-in and document what context it transmits before
source can leave CodeAtlas.

Generated HTML, snapshots, IR, and agent-context exports can contain bounded source excerpts used as
evidence, so treat them with the same confidentiality as the repository. MCP source-evidence
responses can be sent elsewhere by the user's configured MCP host/model after CodeAtlas returns them
over stdio; that external host/provider behavior is outside CodeAtlas itself, and snippets are
labeled as untrusted repository content.

## Troubleshooting

Run `codeatlas doctor`. If the database is corrupt or its schema/indexer version becomes
incompatible, rebuild with `codeatlas index --full`. A malformed configuration must be fixed;
CodeAtlas will not discard it and fall back to defaults.

If `codeatlas` is not found after a global install, inspect npm's global binary directory with
`npm prefix --global`, ensure that directory is on `PATH`, and restart the MCP host. If native
dependency installation fails, confirm that Node.js 22.12 or newer and a supported operating system
are in use, then retry from a clean npm cache.

## Project status

CodeAtlas 0.10 is a stable, local-first release distributed through the
[official npm package](https://www.npmjs.com/package/@dinesh-das/codeatlas). Possible future
distribution work includes Homebrew, standalone binaries, and Windows package-manager support.

Stable publication remains mechanically blocked unless `release-evidence.json` records at least ten
independent repository validations across Linux, macOS, Windows, TypeScript, JavaScript, and Python,
the documented large-repository performance budgets pass, and the SHA-256/file manifest of the exact
packed release artifact matches the evidence manifest. Repository and benchmark evidence expires
after 90 days.
Generate an auditable repository record with
`npm run validate:repository -- --repository /absolute/path --id UNIQUE_AUDIT_ID`; the command tests
the packed artifact in an isolated consumer, evaluates whether the architecture answer is grounded,
relevant, non-repetitive, and production-scoped, and emits commit-, version-, timestamp-, and
atlas-hash-bound JSON for review before it is added to the manifest.
Maintainers can collect the same record on Linux, macOS, or Windows through the manual
`Stable Release Evidence` GitHub workflow.

See the [contribution guide](https://github.com/Dinesh-Das/CodeAtlas/blob/main/CONTRIBUTING.md),
[release process](https://github.com/Dinesh-Das/CodeAtlas/blob/main/RELEASING.md),
[security policy](https://github.com/Dinesh-Das/CodeAtlas/blob/main/SECURITY.md), and
[changelog](https://github.com/Dinesh-Das/CodeAtlas/blob/main/CHANGELOG.md).
