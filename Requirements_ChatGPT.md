# CodeAtlas — Product Requirements & Technical Implementation Specification

**Document Version:** 1.0
**Status:** Implementation Ready
**Target:** MVP → Public Developer Release
**Product Type:** Local-first CLI + MCP developer tool
**Working Name:** CodeAtlas
**Primary Users:** Software developers working with medium-to-large existing codebases

---

# 1. Executive Summary

CodeAtlas is a local-first developer intelligence tool that lives alongside a software repository and creates a continuously updated knowledge graph representing the structure, relationships, architecture, features, and important metadata of the codebase.

CodeAtlas does **not** provide a frontend and does **not** attempt to replace Cursor, Codex, Claude Code, or other coding agents.

Instead, CodeAtlas provides these tools with a reliable structural understanding of the repository through the Model Context Protocol (MCP).

The core architecture is:

```text
Repository
    ↓
CodeAtlas Indexer
    ↓
.codeatlas/
    ↓
Knowledge Graph + Metadata
    ↓
CodeAtlas MCP Server
    ↓
Codex / Cursor / Claude Code / Other Agents
    ↓
Developer
```

The fundamental product principle is:

> The codebase provides the facts. CodeAtlas structures those facts. The LLM explains those facts.

The LLM must never be treated as the source of truth for structural information that can be deterministically derived from source code.

---

# 2. Problem Statement

Modern AI coding tools allow developers to generate and modify software faster than developers can fully understand the resulting architecture.

This creates several problems:

* developers lose understanding of how features work;
* codebases accumulate technical debt rapidly;
* developers repeatedly search through the same files;
* AI agents repeatedly scan repositories to rebuild context;
* changing one component can unexpectedly break another;
* architectural knowledge exists primarily in developers' heads;
* new developers require significant onboarding time;
* generated code can introduce unexpected dependencies;
* large repositories become difficult to reason about;
* LLM answers can be inaccurate because they lack a reliable structural model.

CodeAtlas exists to maintain a persistent and queryable mental model of the project.

---

# 3. Product Vision

A developer should be able to enter any supported repository and run:

```bash
codeatlas init
```

CodeAtlas should analyze the repository and create:

```text
project/
├── src/
├── tests/
├── package.json
├── ...
└── .codeatlas/
    ├── atlas.db
    ├── manifest.json
    ├── state.json
    ├── logs/
    └── lock
```

`.codeatlas/` must automatically be added to `.gitignore`.

The developer's AI coding tool should then be able to ask CodeAtlas questions such as:

```text
How does authentication work?

What happens when POST /checkout is called?

What depends on PaymentService?

If I modify User.id, what can be affected?

Where is notification delivery implemented?

What should I understand before changing payments?

Which areas of this repository have unusually high coupling?
```

CodeAtlas provides the relevant graph nodes, relationships, evidence, source locations, and confidence information.

The AI agent generates the human-readable explanation.

---

# 4. Product Goals

## 4.1 Primary Goals

CodeAtlas must:

1. understand the structural organization of a repository;
2. extract reliable relationships from source code;
3. create a local knowledge graph;
4. keep the graph synchronized with the current working tree;
5. expose the graph to AI agents through MCP;
6. provide evidence for every important structural claim;
7. support feature-level understanding rather than only file-level understanding;
8. support dependency and impact analysis;
9. help developers understand unfamiliar code faster;
10. operate locally without requiring source code to be uploaded to CodeAtlas servers.

---

# 5. Non-Goals

The MVP must NOT attempt to become:

* an IDE;
* a code editor;
* a graphical frontend;
* a Git hosting platform;
* a project management system;
* a ticketing system;
* an autonomous coding agent;
* an automatic refactoring engine;
* a PR generation system;
* a code deployment platform;
* a replacement for Codex, Cursor, Claude Code, etc.;
* a generic vector database over source code.

CodeAtlas is specifically:

> **A persistent structural intelligence layer for software repositories.**

---

# 6. Product Principles

## 6.1 Local First

Repository source code must remain on the developer's machine by default.

CodeAtlas must not require a cloud backend to operate.

---

## 6.2 Deterministic Before Probabilistic

Whenever information can be derived using:

* AST;
* Git;
* configuration;
* schema;
* imports;
* call relationships;
* framework conventions;

CodeAtlas must use deterministic analysis rather than asking an LLM.

---

## 6.3 Evidence Before Explanation

Every graph relationship must know where it came from.

Example:

```json
{
  "source": "AuthController.login",
  "relationship": "CALLS",
  "target": "AuthService.authenticate",
  "evidence": {
    "type": "ast",
    "file": "src/auth/auth.controller.ts",
    "line": 42
  },
  "confidence": 1.0
}
```

---

## 6.4 Never Silently Use Stale Data

Before answering an MCP request, CodeAtlas must verify that its graph corresponds to the current repository state.

If it does not, CodeAtlas must incrementally update the graph before returning results.

---

## 6.5 Progressive Understanding

CodeAtlas should model several levels:

```text
Repository
↓
Domain
↓
Feature
↓
Module
↓
File
↓
Class
↓
Function / Method
↓
Call / Dependency
```

Developers usually ask questions at the feature/domain level.

The graph must support navigation all the way down to the source-code level.

---

# 7. Target Users

## Primary Persona — Developer Joining Existing Project

Needs to understand:

* architecture;
* important modules;
* features;
* dependencies;
* execution flows.

---

## Secondary Persona — Existing Developer

Needs to answer:

* where should I make this change?
* what could this change break?
* why does this dependency exist?
* which files participate in this feature?

---

## Third Persona — AI Coding Agent

Needs structured context before modifying the repository.

Examples:

* Codex;
* Cursor;
* Claude Code;
* VS Code agents;
* other MCP-compatible agents.

---

# 8. Core User Journey

## First Installation

Developer installs CodeAtlas.

Example:

```bash
npm install -g <codeatlas-package>
```

or:

```bash
npx <codeatlas-package> init
```

Exact public package name must be finalized before release.

---

## Repository Initialization

Inside repository:

```bash
codeatlas init
```

CodeAtlas:

1. discovers Git root;
2. creates `.codeatlas/`;
3. adds `.codeatlas/` to `.gitignore`;
4. detects languages;
5. creates configuration;
6. performs initial indexing;
7. stores repository fingerprint;
8. displays MCP setup instructions.

---

## AI Integration

Developer configures:

```text
Codex
Cursor
Claude Code
etc.
```

to launch:

```bash
codeatlas mcp
```

using stdio MCP transport.

---

## Normal Development

Developer changes code.

No manual full reindex should normally be required.

When AI asks CodeAtlas a question:

```text
MCP Request
↓
Freshness Check
↓
Incremental Reindex if Required
↓
Graph Query
↓
Evidence Collection
↓
Structured MCP Response
↓
LLM Explanation
```

---

# 9. Required Technology Stack

## Runtime

Use:

```text
TypeScript
Node.js
```

Reason:

* excellent developer tooling;
* easy npm distribution;
* official Tree-sitter Node bindings;
* strong Git/process support;
* current official MCP TypeScript SDK;
* easiest integration with existing developer environments.

The implementation should target the current supported Node LTS line while avoiding unnecessary runtime-specific APIs.

---

# 10. Parsing Engine

Use:

```text
Tree-sitter
```

Tree-sitter should be responsible for parsing source code into syntax trees.

Architecture:

```text
Source File
   ↓
Language Detector
   ↓
Tree-sitter Parser
   ↓
Language Adapter
   ↓
Normalized CodeAtlas Symbols
```

Each language must implement the same normalized interface.

Example:

```typescript
interface LanguageAdapter {
  language: string;

  parseFile(input: ParseInput): ParsedFile;

  extractSymbols(tree: SyntaxTree): Symbol[];

  extractImports(tree: SyntaxTree): ImportReference[];

  extractCalls(tree: SyntaxTree): CallReference[];

  extractInheritance(tree: SyntaxTree): Relationship[];

  extractExports(tree: SyntaxTree): ExportReference[];
}
```

---

# 11. MVP Language Support

Mandatory:

```text
TypeScript
JavaScript
TSX
JSX
Python
```

Configuration/data formats:

```text
JSON
YAML
TOML
package.json
tsconfig.json
pyproject.toml
```

Additional languages must be implemented through adapters later.

---

# 12. Framework Adapters

Framework-specific extraction must be separate from generic language analysis.

Interface:

```typescript
interface FrameworkAdapter {
  detect(context: RepositoryContext): boolean;

  extractRoutes(...): GraphEntity[];

  extractModels(...): GraphEntity[];

  extractFrameworkRelationships(...): GraphEdge[];
}
```

Initial adapters:

### JavaScript / TypeScript

* Express
* Fastify
* Next.js
* Prisma

### Python

* FastAPI
* Flask
* SQLAlchemy

Framework analysis must remain optional.

Generic AST analysis must still work when no framework is detected.

---

# 13. Storage Architecture

For MVP use:

```text
SQLite
```

Single primary database:

```text
.codeatlas/atlas.db
```

Do not require:

* Neo4j;
* PostgreSQL;
* Docker;
* Redis;
* external graph database.

The graph is represented using normalized node and edge tables.

SQLite is intentionally chosen to keep CodeAtlas:

* embedded;
* portable;
* zero-configuration;
* easy to delete/rebuild;
* easy to ship with CLI tooling.

---

# 14. Knowledge Graph Model

Core entities are represented as nodes.

## Node Types

Initial supported node kinds:

```text
repository
package
directory
module
file
class
interface
function
method
variable
api_route
database_model
database_table
configuration
external_service
test
feature
domain
event
queue
```

---

# 15. Graph Edge Types

Initial supported relationships:

```text
CONTAINS
IMPORTS
EXPORTS
CALLS
REFERENCES
EXTENDS
IMPLEMENTS
DEPENDS_ON
READS_FROM
WRITES_TO
EXPOSES
HANDLES
TRIGGERS
PUBLISHES
SUBSCRIBES
TESTS
BELONGS_TO_FEATURE
BELONGS_TO_DOMAIN
CONFIGURES
USES_EXTERNAL_SERVICE
```

All relationship names must be represented internally as enums/constants.

Avoid arbitrary relationship strings.

---

# 16. Core Database Schema

## nodes

```sql
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT,
    file_path TEXT,
    language TEXT,

    start_line INTEGER,
    start_column INTEGER,
    end_line INTEGER,
    end_column INTEGER,

    signature TEXT,
    visibility TEXT,

    content_hash TEXT,

    source_type TEXT NOT NULL,
    confidence REAL NOT NULL,

    metadata_json TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

## edges

```sql
CREATE TABLE edges (
    id TEXT PRIMARY KEY,

    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,

    edge_type TEXT NOT NULL,

    source_type TEXT NOT NULL,
    confidence REAL NOT NULL,

    file_path TEXT,
    line INTEGER,

    metadata_json TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY(source_node_id) REFERENCES nodes(id),
    FOREIGN KEY(target_node_id) REFERENCES nodes(id)
);
```

---

## files

```sql
CREATE TABLE files (
    path TEXT PRIMARY KEY,

    language TEXT,

    content_hash TEXT NOT NULL,
    size_bytes INTEGER,

    parser_version TEXT,
    adapter_version TEXT,

    indexed_commit TEXT,

    parse_status TEXT,

    indexed_at TEXT NOT NULL
);
```

---

## repository_state

```sql
CREATE TABLE repository_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

Store:

```text
schema_version
codeatlas_version
last_indexed_commit
last_indexed_at
repository_root
repository_id
dirty_fingerprint
```

---

# 17. Node IDs

Node IDs must be deterministic whenever possible.

Example:

```text
sha256(
  repository-id +
  node-kind +
  relative-file-path +
  qualified-name
)
```

This prevents unnecessary graph churn between scans.

Renames may generate a new node unless rename detection can confidently preserve identity.

---

# 18. Search Index

Use SQLite FTS5 for textual lookup across:

* symbol name;
* qualified name;
* file path;
* signatures;
* docstrings;
* documentation metadata;
* feature names.

Example searches:

```text
authentication
PaymentService
checkout
refresh token
UserRepository
```

Vector embeddings are NOT required for V1.

They may be added later as optional enrichment.

---

# 19. Source Code Storage Rule

CodeAtlas must NOT duplicate complete repository source files into SQLite.

Store only structural metadata such as:

* symbol location;
* signature;
* name;
* relationship;
* short doc comment if needed;
* hashes.

When source evidence is required:

```text
graph node
↓
file path + line range
↓
read current working-tree file
↓
return relevant snippet
```

This minimizes stale duplicated source and database size.

---

# 20. Initial Indexing Pipeline

`codeatlas init` or `codeatlas index` must execute:

```text
1. Detect repository root
2. Read ignore rules
3. Discover files
4. Detect languages
5. Hash files
6. Parse supported files
7. Extract symbols
8. Extract imports
9. Resolve references
10. Extract calls
11. Run framework adapters
12. Build graph edges
13. Compute feature/module groupings
14. Compute architecture metrics
15. Store repository state
```

---

# 21. Ignore Rules

CodeAtlas must respect:

```text
.gitignore
.codeatlasignore
```

It must additionally ignore common generated/vendor directories by default:

```text
.git/
.codeatlas/
node_modules/
dist/
build/
coverage/
.next/
venv/
.venv/
__pycache__/
vendor/
target/
```

---

# 22. Secret Protection

Never index:

```text
.env
.env.*
*.pem
*.key
*.p12
*.pfx
id_rsa
id_ed25519
credentials.*
```

unless explicitly overridden by the user.

Symlinks pointing outside the repository must be ignored by default.

---

# 23. Incremental Update System

This is a critical requirement.

CodeAtlas must not rely on developers remembering to run another full scan.

Repository state must support:

```text
Last indexed commit
+
Working-tree state
+
File hashes
```

---

# 24. Freshness Algorithm

Before every MCP query:

```text
current repository
        ↓
calculate lightweight repository fingerprint
        ↓
compare with indexed fingerprint
        ↓
same?
 ┌──────┴───────┐
YES             NO
 ↓               ↓
Query       Incremental Sync
Graph            ↓
             Query Graph
```

The MCP server must never knowingly return stale information.

---

# 25. Detecting Changes

Use Git wherever possible.

Determine:

```text
added files
modified files
deleted files
renamed files
untracked files
```

Sources:

```bash
git diff
git diff --cached
git status --porcelain
git rev-parse HEAD
```

File hashing acts as an additional correctness layer.

---

# 26. Incremental Reindex

For a changed file:

```text
remove outdated nodes generated from file
↓
remove/invalidate affected edges
↓
reparse file
↓
recreate nodes
↓
resolve imports/references again
↓
recompute affected dependency neighborhood
↓
invalidate affected feature metadata
```

Deleted files must remove their graph entities.

Renamed files should use Git rename detection where possible.

---

# 27. Dependency-Neighborhood Recalculation

Suppose:

```text
PaymentService
```

changes.

CodeAtlas must consider:

```text
PaymentService
↓
symbols inside file
↓
dependencies
↓
direct callers
↓
feature membership
↓
affected architecture metrics
```

The whole repository should NOT be reparsed unless required.

---

# 28. Full Reindex Conditions

Force full indexing if:

* graph schema version changes;
* parser version becomes incompatible;
* CodeAtlas indexing algorithm changes;
* repository root changes;
* database corruption is detected;
* Git history becomes inconsistent with saved index state;
* user executes:

```bash
codeatlas index --full
```

---

# 29. File Watcher

A persistent watcher is optional for the first production MVP.

Correctness must NOT depend on a watcher.

Freshness checking before MCP requests is mandatory.

A watcher may later improve latency by updating the index proactively.

---

# 30. Feature Detection

CodeAtlas must attempt to organize low-level code into higher-level features.

Example:

```text
Feature: Authentication

Contains:
POST /login
AuthController
AuthService
JWTService
UserRepository
JWTMiddleware
```

Feature detection must combine deterministic signals.

Signals can include:

* directories;
* module names;
* route names;
* service names;
* import communities;
* database relationships;
* tests;
* framework modules;
* naming conventions.

---

# 31. Feature Confidence

Features inferred through heuristics must have confidence scores.

Example:

```json
{
  "name": "Authentication",
  "type": "feature",
  "confidence": 0.84,
  "evidence": [
    "src/auth/",
    "POST /login",
    "AuthService",
    "AuthController",
    "auth.integration.test.ts"
  ]
}
```

The system must differentiate:

```text
verified structural fact
heuristic inference
documentation-derived context
```

---

# 32. Provenance Model

Every node/edge must contain:

```text
source_type
confidence
evidence
```

Valid `source_type` values:

```text
ast
framework
config
schema
git
documentation
heuristic
```

General confidence guidelines:

```text
AST relationship          1.00
Exact framework pattern   0.95+
Config relationship       0.95+
Schema relationship       0.95+
Git evidence              0.80–1.00
Heuristic grouping        0.50–0.90
```

The LLM must be able to differentiate these categories.

---

# 33. Architecture Metrics

CodeAtlas should calculate deterministic technical-debt indicators.

MVP indicators:

```text
fan-in
fan-out
dependency depth
circular dependencies
highly connected modules
large files
large functions
high-change files
cross-domain dependency count
```

Git history may additionally provide:

```text
commit frequency
recent churn
number of contributors
```

These metrics must be presented as signals rather than definitive judgments.

Example:

```text
PaymentService

fan-in: 17
fan-out: 13
recent churn: high
architecture risk: elevated
```

Do not claim:

```text
"This code is bad"
```

Instead:

```text
"This component has unusually high coupling."
```

---

# 34. MCP Server

Command:

```bash
codeatlas mcp
```

The server should initially use:

```text
stdio
```

transport.

Use the official MCP SDK.

The MCP implementation must be independent of any single LLM provider.

---

# 35. Required MCP Tools

## `codeatlas_status`

Purpose:

Return:

```text
repository
index status
current commit
indexed commit
dirty state
supported languages
last indexed time
```

---

## `codeatlas_overview`

Returns high-level architecture.

Example:

```json
{
  "domains": [],
  "features": [],
  "entrypoints": [],
  "database_models": [],
  "external_services": []
}
```

---

## `codeatlas_search`

Input:

```json
{
  "query": "authentication"
}
```

Search:

* features;
* symbols;
* APIs;
* files;
* database models.

---

## `codeatlas_get_node`

Input:

```json
{
  "node_id": "..."
}
```

Returns:

* metadata;
* location;
* incoming relationships;
* outgoing relationships;
* feature membership;
* evidence.

---

## `codeatlas_explain_feature`

This tool does NOT call an LLM.

It returns the grounded context required for the host LLM to explain the feature.

Input:

```json
{
  "feature": "authentication"
}
```

Return:

```json
{
  "feature": {},
  "entrypoints": [],
  "components": [],
  "execution_paths": [],
  "database_dependencies": [],
  "external_dependencies": [],
  "source_evidence": [],
  "uncertainties": []
}
```

---

## `codeatlas_trace`

Input example:

```json
{
  "from": "POST /checkout",
  "max_depth": 8
}
```

Returns execution/dependency path:

```text
POST /checkout
→ CheckoutController
→ CheckoutService
→ PaymentService
→ StripeClient
```

Every hop must contain evidence.

---

## `codeatlas_impact`

Input:

```json
{
  "target": "User.id"
}
```

Return:

```text
direct dependents
transitive dependents
affected features
affected APIs
affected models
affected tests
confidence
```

Must explicitly distinguish:

```text
definitely affected
potentially affected
```

---

## `codeatlas_dependencies`

Input:

```json
{
  "target": "PaymentService",
  "direction": "both"
}
```

Return dependency neighborhood.

---

## `codeatlas_source`

Return a minimal source-code range for a graph entity.

Must enforce response-size limits.

---

## `codeatlas_health`

Return architecture/technical-debt signals.

Example:

```text
circular dependencies
high fan-out components
high churn + high connectivity components
large functions
```

---

# 36. MCP Answer Packet

CodeAtlas should structure responses in a model-friendly format.

Example:

```json
{
  "answer_context": {
    "topic": "authentication"
  },

  "facts": [
    {
      "statement": "POST /login is handled by AuthController.login",
      "confidence": 1,
      "evidence": {
        "file": "src/auth/auth.controller.ts",
        "line": 31
      }
    }
  ],

  "relationships": [],

  "source_snippets": [],

  "uncertainties": [],

  "freshness": {
    "commit": "abc123",
    "working_tree_checked": true
  }
}
```

---

# 37. Accuracy Requirements

The following rules are mandatory.

## Rule 1

Never invent graph relationships.

---

## Rule 2

If symbol resolution fails:

```text
resolution = unresolved
```

rather than guessing.

---

## Rule 3

Every important relationship must have evidence.

---

## Rule 4

Heuristic relationships must have confidence below deterministic relationships.

---

## Rule 5

Source locations must always reference the current working tree.

---

## Rule 6

If evidence is insufficient, MCP should explicitly return:

```text
insufficient_evidence
```

---

## Rule 7

The model should be encouraged to say:

> CodeAtlas could not verify this relationship.

instead of generating an unsupported explanation.

---

# 38. Prompt-Injection Protection

Repository content is untrusted input.

Comments such as:

```text
IGNORE PREVIOUS INSTRUCTIONS
```

must be treated strictly as source text.

CodeAtlas itself must never interpret comments or documentation as executable instructions.

MCP responses should label source excerpts as:

```text
untrusted_repository_content
```

where appropriate.

---

# 39. CLI Commands

Required:

```bash
codeatlas init
```

Initialize repository.

---

```bash
codeatlas index
```

Index repository incrementally.

---

```bash
codeatlas index --full
```

Rebuild entire index.

---

```bash
codeatlas status
```

Show synchronization status.

---

```bash
codeatlas doctor
```

Validate installation, parsers, Git, database, MCP compatibility.

---

```bash
codeatlas mcp
```

Start MCP stdio server.

---

```bash
codeatlas clean
```

Delete local index safely.

Must require confirmation unless:

```bash
--force
```

is supplied.

---

# 40. Optional CLI Debug Commands

Recommended:

```bash
codeatlas inspect PaymentService
```

and:

```bash
codeatlas trace "POST /checkout"
```

These help debug indexing without requiring an LLM.

---

# 41. Configuration

Location:

```text
.codeatlas/config.json
```

Example:

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

---

# 42. `.codeatlasignore`

Users can exclude:

```text
examples/
fixtures/
generated/
legacy/
```

Rules should behave similarly to `.gitignore`.

---

# 43. Repository Structure for CodeAtlas Implementation

The CodeAtlas project itself should use:

```text
codeatlas/
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── CHANGELOG.md
├── SECURITY.md
│
├── src/
│   ├── cli/
│   │   ├── init.ts
│   │   ├── index.ts
│   │   ├── status.ts
│   │   ├── doctor.ts
│   │   └── mcp.ts
│   │
│   ├── core/
│   │   ├── repository.ts
│   │   ├── config.ts
│   │   ├── ignore.ts
│   │   ├── hashing.ts
│   │   └── freshness.ts
│   │
│   ├── parser/
│   │   ├── parser.ts
│   │   ├── languages/
│   │   │   ├── typescript.ts
│   │   │   ├── javascript.ts
│   │   │   └── python.ts
│   │   └── frameworks/
│   │       ├── express.ts
│   │       ├── fastify.ts
│   │       ├── nextjs.ts
│   │       ├── fastapi.ts
│   │       ├── flask.ts
│   │       ├── prisma.ts
│   │       └── sqlalchemy.ts
│   │
│   ├── graph/
│   │   ├── types.ts
│   │   ├── builder.ts
│   │   ├── resolver.ts
│   │   ├── traversal.ts
│   │   ├── impact.ts
│   │   └── features.ts
│   │
│   ├── storage/
│   │   ├── database.ts
│   │   ├── migrations.ts
│   │   ├── nodes.ts
│   │   ├── edges.ts
│   │   ├── files.ts
│   │   └── search.ts
│   │
│   ├── analysis/
│   │   ├── cycles.ts
│   │   ├── coupling.ts
│   │   ├── churn.ts
│   │   └── architecture.ts
│   │
│   ├── git/
│   │   ├── repository.ts
│   │   ├── diff.ts
│   │   └── history.ts
│   │
│   └── mcp/
│       ├── server.ts
│       ├── schemas.ts
│       └── tools/
│           ├── overview.ts
│           ├── search.ts
│           ├── node.ts
│           ├── feature.ts
│           ├── impact.ts
│           ├── trace.ts
│           ├── source.ts
│           └── health.ts
│
├── migrations/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   └── e2e/
│
└── scripts/
```

---

# 44. Module Boundaries

Strict separation must exist between:

```text
Parser
Graph
Storage
Git
MCP
CLI
```

MCP tools must NOT contain parsing logic.

Parser modules must NOT know about MCP.

Graph analysis must operate over normalized graph entities rather than language-specific syntax trees.

---

# 45. Performance Requirements

Target initial performance:

### Small repository

```text
< 50k LOC
Initial index: < 10 seconds
```

### Medium repository

```text
~100k LOC
Initial index: < 30 seconds
```

### Large repository

```text
~500k LOC
Initial index target: < 2 minutes
```

Machine performance will vary, so these are engineering targets rather than absolute guarantees.

---

# 46. Incremental Performance

For fewer than 10 changed files:

```text
target incremental refresh: < 2 seconds
```

Graph-only MCP queries after freshness verification:

```text
target: < 500 ms
```

excluding very large traversals.

---

# 47. Query Limits

Prevent accidental graph explosions.

Defaults:

```text
max traversal depth: 10
max returned nodes: 200
max source snippet lines: 120
max execution paths: 20
```

Support pagination.

---

# 48. Concurrency

Only one index writer may modify:

```text
atlas.db
```

at a time.

Use:

```text
.codeatlas/lock
```

or equivalent OS-level locking.

MCP readers should not observe partially updated graph state.

Incremental graph updates must occur transactionally.

---

# 49. Failure Recovery

If indexing crashes:

* previous valid graph must remain usable where possible;
* incomplete transactions must rollback;
* state must not claim successful indexing;
* `codeatlas doctor` must detect corrupted state.

If database corruption occurs:

```bash
codeatlas index --full
```

should recreate it.

---

# 50. Logging

Store debug logs under:

```text
.codeatlas/logs/
```

Default CLI output should remain concise.

Support:

```bash
CODEATLAS_LOG_LEVEL=debug
```

Log levels:

```text
error
warn
info
debug
trace
```

Never log secrets or entire source files.

---

# 51. Privacy

Default behavior:

```text
No source-code upload
No CodeAtlas cloud account
No mandatory telemetry
No remote database
No remote LLM calls
```

Important distinction:

When an MCP-connected AI agent asks for source evidence, the agent itself may send that evidence to its configured model provider.

CodeAtlas documentation must explain this clearly.

---

# 52. Telemetry

MVP:

```text
OFF by default
```

If later introduced, telemetry must be explicitly opt-in.

Never transmit:

* source code;
* symbol names;
* filenames;
* Git history;
* repository names;
* secrets.

---

# 53. Git Requirements

CodeAtlas should work best in Git repositories.

Git provides:

* root detection;
* commit identity;
* change detection;
* rename detection;
* churn analysis.

Non-Git directories may be supported later.

MVP may return:

```text
CodeAtlas currently requires a Git repository.
```

for non-Git directories.

---

# 54. Git History Analysis

Optional metadata:

```text
last_modified_commit
last_modified_date
commit_count
recent_churn
```

Do not index full commit diffs by default.

Use Git history primarily to surface development hotspots.

---

# 55. Technical Debt Signals

Initial implementation:

## Circular imports

Example:

```text
A → B → C → A
```

---

## High fan-out

A component depends on unusually many components.

---

## High fan-in

A component has many dependents and therefore high change impact.

---

## Large symbols

Functions/classes exceeding configurable thresholds.

---

## Change hotspots

Components with both:

```text
high churn
+
high connectivity
```

should receive elevated attention.

---

# 56. Testing Strategy

Testing is mandatory at four levels.

---

## Unit Tests

Test:

* hashing;
* ignore patterns;
* graph IDs;
* parsing helpers;
* relationship resolution;
* traversal algorithms;
* confidence rules.

---

## Parser Fixture Tests

Create fixtures for every supported language.

Example:

```text
tests/fixtures/typescript/basic-calls/
tests/fixtures/typescript/express/
tests/fixtures/python/fastapi/
tests/fixtures/python/sqlalchemy/
```

Each fixture must have an expected graph snapshot.

---

## Integration Tests

Test:

```text
repository
→ index
→ graph
→ query
```

---

## End-to-End MCP Tests

Run:

```text
temporary Git repo
↓
CodeAtlas init
↓
MCP server
↓
MCP request
↓
validate response
```

---

# 57. Critical Freshness Test

Test scenario:

1. create repository;
2. index repository;
3. query `PaymentService`;
4. modify `PaymentService`;
5. DO NOT manually run index;
6. issue another MCP query;
7. verify incremental update occurs;
8. verify response references new code;
9. verify old relationships are removed.

This test must pass before public release.

---

# 58. Deletion Test

1. index file;
2. verify nodes exist;
3. delete file;
4. query graph;
5. verify nodes/edges from deleted file are removed.

---

# 59. Rename Test

1. index repository;
2. rename service;
3. change imports;
4. query;
5. verify graph reflects new structure.

---

# 60. Uncommitted Change Test

CodeAtlas must work with:

```text
dirty working tree
```

The user should not have to commit code before CodeAtlas sees it.

This is essential.

---

# 61. Accuracy Test Corpus

Create known fixture repositories where exact expected relationships are defined.

Example:

```text
Controller
→ Service
→ Repository
→ Database
```

Expected graph is checked automatically.

Accuracy should be evaluated independently of LLM behavior.

---

# 62. MCP Contract Tests

Tool response schemas must use schema validation.

Breaking MCP schema changes require a major version bump.

---

# 63. Versioning

Use semantic versioning:

```text
MAJOR.MINOR.PATCH
```

Graph schema must have a separate:

```text
schema_version
```

When incompatible graph changes occur:

```text
CodeAtlas detects mismatch
→ requests/requires rebuild
```

---

# 64. Distribution

Primary distribution:

```text
npm
```

Later:

```text
Homebrew
standalone binaries
Windows package manager
```

Do not require Docker.

---

# 65. First-Time Experience

Desired:

```bash
$ codeatlas init

✓ Repository detected
✓ TypeScript detected
✓ Python detected
✓ Added .codeatlas/ to .gitignore
✓ Indexed 1,247 files
✓ Found 8,491 symbols
✓ Found 14,820 relationships
✓ Detected 23 API routes
✓ Detected 18 database models
✓ CodeAtlas is ready

Run:
  codeatlas mcp
```

---

# 66. Status Experience

```bash
$ codeatlas status

Repository: my-project
Branch: main
HEAD: 93fa218

Index:
  Status: up to date
  Files: 1,247
  Symbols: 8,491
  Relationships: 14,820
  Features: 19

Last indexed:
  2 minutes ago
```

---

# 67. Developer Experience Requirement

The product must require minimal configuration.

Ideal flow:

```text
install
↓
codeatlas init
↓
connect MCP
↓
done
```

Do not require developers to:

* configure databases;
* start Docker;
* create API keys;
* create cloud accounts.

---

# 68. Documentation Requirements

Public release must include:

```text
README.md
Getting Started
Installation
MCP Setup
Supported Languages
Supported Frameworks
How Freshness Works
Privacy Model
Troubleshooting
Architecture
Contributing
Security Policy
```

---

# 69. Example README Positioning

> CodeAtlas builds a living knowledge graph of your repository and exposes it to AI coding agents through MCP.
>
> Instead of repeatedly searching your entire codebase, your coding agent can ask CodeAtlas how features, modules, functions, APIs, and data models are connected.

---

# 70. Acceptance Criteria — MVP

The MVP is considered functionally complete when all the following are true.

### Installation

* CLI installs successfully.
* `codeatlas init` works in a Git repository.
* `.codeatlas/` is automatically ignored.

### Parsing

* TypeScript supported.
* JavaScript supported.
* Python supported.
* files/classes/functions/methods/imports extracted.

### Graph

* nodes stored.
* edges stored.
* call relationships stored.
* import relationships stored.
* graph traversal works.

### Frameworks

At least:

* Express;
* FastAPI;
* Prisma;
* SQLAlchemy;

have basic extraction support.

### Freshness

* committed changes detected.
* uncommitted changes detected.
* new files detected.
* deleted files detected.
* incremental reindex works.
* MCP cannot knowingly query stale graph state.

### MCP

These tools work:

```text
status
overview
search
get_node
explain_feature
trace
impact
dependencies
source
health
```

### Accuracy

* deterministic relationships contain evidence.
* file and line references are correct.
* unresolved relationships are not guessed.
* confidence information exists for inferred graph entities.

### Privacy

* no cloud backend required.
* no source transmitted by CodeAtlas itself.

### Quality

* automated tests passing.
* CI configured.
* README complete.
* package can be installed by external developers.

---

# 71. Implementation Order for Coding Agent

The implementation agent should build CodeAtlas in the following sequence.

## Phase 1 — Foundation

Build:

```text
CLI
repository detection
config
SQLite
migrations
file discovery
hashing
.gitignore integration
```

Exit condition:

```text
codeatlas init
```

creates a valid local workspace.

---

## Phase 2 — Structural Indexer

Implement:

```text
Tree-sitter
TypeScript
JavaScript
Python
symbol extraction
imports
exports
classes
functions
methods
```

Exit condition:

A fixture repository generates deterministic graph nodes.

---

## Phase 3 — Relationship Resolution

Implement:

```text
IMPORTS
CALLS
EXTENDS
IMPLEMENTS
REFERENCES
```

Exit condition:

Known fixture call graphs exactly match expected snapshots.

---

## Phase 4 — Incremental Indexing

Implement:

```text
Git state
file hashes
dirty working tree
added files
modified files
deleted files
renames
dependency invalidation
```

Exit condition:

Changing a file updates only the required graph sections.

---

## Phase 5 — Framework Adapters

Implement initial framework extraction.

Exit condition:

Known API/database fixtures correctly create:

```text
api_route
database_model
```

nodes.

---

## Phase 6 — Architecture Analysis

Implement:

```text
features
domains
dependency communities
cycles
coupling
hotspots
```

Exit condition:

Repository overview returns meaningful high-level structure.

---

## Phase 7 — MCP

Implement official MCP server.

Exit condition:

An external MCP client can call CodeAtlas tools through stdio.

---

## Phase 8 — Accuracy/Evidence

Ensure every tool returns:

```text
facts
evidence
confidence
freshness
uncertainties
```

Exit condition:

No structural claim is returned without provenance.

---

## Phase 9 — Packaging

Complete:

```text
npm packaging
CI
release workflow
docs
examples
security docs
```

Exit condition:

A developer who has never seen the project can install and use it from README instructions.

---

# 72. Definition of Done

CodeAtlas V1 is done when a developer can:

```bash
cd unfamiliar-project
codeatlas init
```

connect Codex/Cursor/Claude Code to:

```bash
codeatlas mcp
```

and ask:

```text
How does checkout work?
```

The AI should be able to obtain from CodeAtlas:

```text
checkout feature
↓
API entry point
↓
controller
↓
services
↓
repositories
↓
database models
↓
external dependencies
↓
tests
```

with exact source evidence.

Then the developer should be able to modify the repository and immediately ask the same question again without manually rebuilding the entire index.

The second answer must reflect the current working tree.

That is the core product contract.

---

# 73. Core Success Metric

The primary product metric is:

> **Reduction in time required for a developer or coding agent to obtain an accurate mental model of an unfamiliar part of a repository.**

Secondary metrics:

```text
indexing accuracy
incremental update latency
MCP query latency
relationship resolution rate
percentage of claims with deterministic evidence
developer onboarding time
```

---

# 74. Final Product Principle

CodeAtlas must not attempt to make the LLM smarter by simply giving it more source code.

CodeAtlas must make the LLM more accurate by giving it **better structured evidence**.

The architecture should always preserve this separation:

```text
Source Code
    ↓
Deterministic Analysis
    ↓
Knowledge Graph
    ↓
Evidence Retrieval
    ↓
LLM
    ↓
Developer Explanation
```

**The graph owns the facts.
The LLM owns the explanation.
The current working tree remains the ultimate source of truth.**
