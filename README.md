# CodeAtlas

CodeAtlas builds a local, persistent structural index of a Git repository. The long-term
product exposes an evidence-bearing knowledge graph to AI coding agents through MCP; the
current implementation is the Phase 1 foundation defined by the product specification.

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
- Transactional metadata indexing, deleted-file cleanup, status checks, and a single-writer
  workspace lock.
- Unit and integration tests using disposable real Git repositories.

Source files are currently marked `pending_parser`. Tree-sitter language adapters and their
evidence-bearing symbols are Phase 2. Relationship resolution and the MCP server follow in
Phase 3; `codeatlas mcp` intentionally reports that boundary instead of returning incomplete
or ungrounded data.

## Requirements

- Node.js 22.12 or newer (Node.js 24 LTS recommended)
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
codeatlas init [path]         Create the workspace and initial metadata graph
codeatlas index [path]        Synchronize changed/deleted file metadata
codeatlas index --full [path] Rebuild graph metadata transactionally
codeatlas status [path]       Compare the working tree with the stored fingerprint
codeatlas status --json       Return machine-readable status
codeatlas doctor [path]       Check Node, Git, config, SQLite integrity, and WAL
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

The database stores structural metadata and hashes, not complete source files or string
literal values. The Phase 1 graph contains repository, directory, and file nodes plus
containment edges. Source contents remain in the working tree.

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
                         Parser contracts (Phase 2)
MCP (Phase 3) → Graph queries + freshness gate
```

- `src/cli`: command presentation and process behavior
- `src/core`: configuration, discovery, hashing, ignores, workspace, freshness
- `src/git`: Git process boundary and repository identity
- `src/graph`: normalized graph contracts and deterministic IDs
- `src/storage`: SQLite lifecycle, migrations, repositories, and FTS search
- `src/indexer`: orchestration and transactional graph writes
- `src/parser`: normalized, evidence-bearing parser contract

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

1. Tree-sitter TypeScript, JavaScript, TSX, JSX, and Python adapters with provenance.
2. Import/call/inheritance/reference resolution and a typed MCP skeleton.
3. Incremental dependency-neighborhood invalidation and Git rename identity preservation.
4. Express, FastAPI, Prisma, and SQLAlchemy adapters.
5. Feature/domain grouping, cycles, coupling, churn, and health signals.
6. Full grounded MCP query tools, hardening, packaging, and public release documentation.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[CHANGELOG.md](CHANGELOG.md).
