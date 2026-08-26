# CodeAtlas

CodeAtlas builds a local, persistent structural index of a Git repository. The long-term
product exposes an evidence-bearing knowledge graph to AI coding agents through MCP; the
current implementation includes the Phase 1 foundation and Phase 2 structural indexer defined
by the product specification.

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
- Deterministic AST `CONTAINS` and `EXPORTS` relationships plus normalized unresolved imports.
- Literal-safe signatures that redact assigned/default string values before persistence.
- Transactional structural indexing, deleted-file cleanup, status checks, and a single-writer
  workspace lock.
- Parser graph snapshots plus unit, integration, and compiled-CLI tests using disposable Git
  repositories.

Import, call, inheritance, implementation, and general-reference resolution follow in Phase 3,
along with the typed MCP skeleton. `codeatlas mcp` intentionally reports that boundary instead
of returning incomplete or ungrounded data.

## Requirements

- Node.js 24 LTS or newer
- Git
- npm

Non-Git directories are not supported in V1.

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
codeatlas index [path]        Synchronize changed/deleted files and AST entities
codeatlas index --full [path] Rebuild the structural graph transactionally
codeatlas status [path]       Compare the working tree with the stored fingerprint
codeatlas status --json       Return machine-readable status
codeatlas doctor [path]       Check Node, parsers, Git, config, SQLite, and WAL
codeatlas clean [path]        Remove the local index after confirmation
codeatlas clean --force       Remove it non-interactively
codeatlas mcp                 Reserved for the Phase 3 grounded MCP implementation
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
values. Its graph contains repository, directory, file, module, class, interface, function,
method, and variable nodes with containment and export edges. Source contents remain in the
working tree.

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
    "featureDetection": true
  },
  "limits": {
    "maxTraversalDepth": 10,
    "maxSourceSnippetLines": 120,
    "maxMcpResultNodes": 200
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
working tree; `codeatlas index` updates the database and fingerprint in one SQLite transaction.

## Architecture

Modules remain one-directional:

```text
CLI → Indexer → Core / Git / Graph / Storage
              ↘ Tree-sitter language adapters
MCP (Phase 3) → Graph queries + freshness gate
```

- `src/cli`: command presentation and process behavior
- `src/core`: configuration, discovery, hashing, ignores, workspace, freshness
- `src/git`: Git process boundary and repository identity
- `src/graph`: normalized graph contracts and deterministic IDs
- `src/storage`: SQLite lifecycle, migrations, repositories, and FTS search
- `src/indexer`: orchestration and transactional graph writes
- `src/parser`: normalized parser contract, adapter registry, and Tree-sitter implementations

Parser code will not depend on MCP. MCP tools will not parse source. Graph/storage entities do
not contain Tree-sitter-specific objects.

## Privacy

CodeAtlas has no cloud account, remote database, telemetry, API key, or network upload path.
It does not call an LLM. Future MCP source-evidence responses may be sent elsewhere by the
user's configured MCP host/model; that is separate from CodeAtlas itself and will be labeled
as untrusted repository content.

## Troubleshooting

Run `codeatlas doctor`. If the database is corrupt or its schema/indexer version becomes
incompatible, rebuild with `codeatlas index --full`. A malformed configuration must be fixed;
CodeAtlas will not discard it and fall back to defaults.

## Roadmap from the specification

1. Import/call/inheritance/reference resolution and a typed MCP skeleton.
2. Incremental dependency-neighborhood invalidation and Git rename identity preservation.
3. Express, FastAPI, Prisma, and SQLAlchemy adapters.
4. Feature/domain grouping, cycles, coupling, churn, and health signals.
5. Full grounded MCP query tools, hardening, packaging, and public release documentation.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CHANGELOG.md](CHANGELOG.md).
