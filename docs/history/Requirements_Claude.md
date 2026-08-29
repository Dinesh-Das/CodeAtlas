Here are the findings, organized by class, followed by targeted rewrites of the affected sections.

---

## Findings

### Category A — Specification Gaps (blocking for implementation)

**A1. Fingerprint composition undefined (§24, §25)**
"Lightweight repository fingerprint" is referenced but never defined. Without a canonical definition, two implementations will diverge.

**A2. Ambiguous symbol resolution unhandled (§10, §26, §32)**
The rule "unresolved rather than guessing" handles zero-match cases. Multi-match cases (e.g., `AuthService` exported from two modules) are not addressed. An agent receiving multiple candidates with no confidence signal cannot reason about them.

**A3. Rename identity threshold is prose (§17)**
"Unless rename detection can confidently preserve identity" — "confidently" is not a number. This is an implementation-time decision disguised as a requirement.

**A4. Schema migration is ambiguous (§28, §63)**
"Requests/requires rebuild" conflates two behaviors. Does the tool block on mismatch? Prompt the user? Proceed with stale data? Each has different consequences.

**A5. Config validation behavior missing (§41)**
No error path specified when `.codeatlas/config.json` is malformed. Silent fallback to defaults masks accidental truncation.

**A6. MCP Answer Packet schemas incomplete (§36)**
`source_snippets` and `relationships` are shown as empty arrays with no element schema. The MCP contract tests (§62) cannot be written against undefined schemas.

**A7. Pagination interface undefined (§47)**
"Support pagination" is stated without defining the pagination interface. Each tool author will invent a different one.

**A8. String literal indexing scope unspecified (§19, §22)**
§22 excludes secret files by path pattern. It does not address API keys embedded in source code. If string literal values are stored as part of symbol metadata or signatures, secrets leak into the database.

---

### Category B — Contradictions

**B1. Non-Git support hedged but Git is a hard dependency throughout (§25, §53)**
§53 says MVP "may return" an error for non-Git directories. §25 uses `git diff`, `git status --porcelain`, and `git rev-parse HEAD` as the primary change detection mechanism — not as one strategy among several. The hedge implies a non-Git path exists; it does not.

**B2. Phase 8 implies provenance is optional until the end (§71)**
Provenance is a core invariant (§6.3, §32, §37). A separate accuracy phase signals it can be deferred. Anything built in Phases 2–3 without provenance will require a full rewrite to add it, not a pass.

---

### Category C — Missing Requirements

**C1. SQLite journal mode unspecified (§48)**
§48 requires readers to not observe partially updated state. Without WAL mode, readers block on every write transaction. WAL mode is not a performance preference here; it is required for the stated behavior.

**C2. `codeatlas_trace` uses `"from"` as a field name (§35)**
`from` is a reserved word in SQL and multiple target languages. This creates friction in generated client code and query construction.

**C3. `codeatlas_source` size limit is detached from config (§35, §41)**
§35 says the tool "must enforce response-size limits." §41 defines `maxSourceSnippetLines`. These are the same limit; they must be explicitly coupled.

**C4. Reference machine missing from performance targets (§45)**
"Machine performance will vary" makes the targets unverifiable in CI. Performance regression tests require a fixed reference point.

---

### Category D — Redundancy

**D1. Freshness principle restated in §6.4, §24, and §37.** One authoritative statement; others cross-reference.

**D2. Provenance principle restated in §6.3, §32, and §37.** Same.

**D3. Local-first principle restated in §6.1 and §51.** Same.

---

### Category E — Phase Ordering

**E1. MCP skeleton deferred too long (§71)**
MCP appears in Phase 7, after Architecture Analysis. This delays end-to-end testing feedback by roughly three phases. A stub MCP server returning typed empty responses should exist by Phase 3. The contract is then verifiable incrementally as features land.

**E2. Phase 8 should not exist (§71)**
See B2. Provenance is an invariant, not a finishing pass.

---

## Revised Sections

Only sections that changed materially are reproduced below. All other sections remain as written.

---

### §17 — Node IDs (revised)

Node IDs must be deterministic:

```
sha256(repository_id + ":" + node_kind + ":" + relative_file_path + ":" + qualified_name)
```

**Rename handling:**

If Git reports a rename with ≥ 50% similarity (equivalent to `git diff --find-renames=50%`), CodeAtlas preserves the original node ID and updates `file_path`, `qualified_name`, and `updated_at`. The rename is recorded as a `RENAMED_FROM` edge with `source_type: git`, `confidence: 0.95`.

If Git similarity is below 50%, or if Git rename detection is not available for the file pair, treat as delete + create. The old node is removed; a new node is created with a new ID.

---

### §22 — Secret Protection (revised)

Never index files matching these path patterns:

```
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

Additionally:

**String literal values must never be stored in the database.** This applies to symbol metadata, signatures, and any other stored field. Extracting the name, location, and type of a variable is permitted; extracting its assigned string value is not. This prevents embedded API keys and tokens from leaking into `atlas.db`.

Symlinks pointing outside the repository root must be ignored by default.

---

### §24 — Freshness Algorithm (revised)

Before every MCP query, CodeAtlas computes a repository fingerprint and compares it against the stored fingerprint.

**Fingerprint definition:**

```
fingerprint = sha256(
  HEAD_commit_hash
  + "|"
  + sha256(sorted_join(["{path}:{content_hash}" for each Git-tracked file]))
  + "|"
  + sha256(sorted_join(["{path}:{content_hash}" for each untracked, non-ignored file]))
)
```

Where `sorted_join` sorts entries lexicographically and joins with newlines.

The fingerprint is stored in `repository_state` under the key `dirty_fingerprint`.

Decision:

```
fingerprint_current == fingerprint_stored
         ↓                    ↓
      Query              Incremental sync
      Graph              then Query Graph
```

The MCP server must never return results computed against a state that does not match the current fingerprint.

---

### §25 — Detecting Changes (revised)

Use Git as the primary change signal. Non-Git directories are not supported in V1.

Determine changed files by diffing the current fingerprint against the stored fingerprint:

```bash
git diff --name-status HEAD
git diff --cached --name-status
git status --porcelain
git rev-parse HEAD
```

Classify each change as: added, modified, deleted, renamed.

File content hashing acts as a correctness layer for cases where Git status is inconsistent with actual on-disk content (e.g., `--assume-unchanged` flags, filesystem timestamp issues). The fingerprint defined in §24 is the authoritative staleness signal.

**V1 requirement: Git repository is required.** If `git rev-parse --git-dir` fails in the working directory, CodeAtlas exits with:

```
Error: CodeAtlas requires a Git repository. Non-Git directories are not supported in V1.
```

Non-Git support is a post-V1 item and must not be designed for in the MVP.

---

### §36 — MCP Answer Packet (revised, schemas completed)

```json
{
  "answer_context": {
    "topic": "string",
    "tool": "string"
  },

  "facts": [
    {
      "statement": "string",
      "confidence": 1.0,
      "source_type": "ast | framework | config | schema | git | documentation | heuristic",
      "evidence": {
        "file": "string (relative path)",
        "line": 42,
        "column": 0
      }
    }
  ],

  "relationships": [
    {
      "source_node_id": "string",
      "target_node_id": "string",
      "edge_type": "string (EdgeType enum value)",
      "confidence": 1.0,
      "source_type": "string",
      "evidence": {
        "file": "string",
        "line": 42
      }
    }
  ],

  "source_snippets": [
    {
      "node_id": "string",
      "file": "string (relative path)",
      "start_line": 40,
      "end_line": 55,
      "content": "string (read from current working tree, max maxSourceSnippetLines lines)",
      "trust": "untrusted_repository_content"
    }
  ],

  "uncertainties": [
    {
      "description": "string",
      "reason": "unresolved_reference | insufficient_evidence | heuristic_only | multi_candidate",
      "candidates": ["node_id_1", "node_id_2"]
    }
  ],

  "freshness": {
    "fingerprint": "string (sha256 hex)",
    "head_commit": "string",
    "working_tree_checked": true,
    "checked_at": "ISO 8601"
  },

  "pagination": {
    "cursor": "string | null",
    "has_more": false
  }
}
```

`source_snippets[].trust` must always be `"untrusted_repository_content"`. This label must appear on every snippet regardless of content. It signals to the host LLM that comments within the snippet must not be interpreted as instructions.

---

### §35 — MCP Tools (field name corrections and coupling)

**`codeatlas_trace` input — rename `from` → `start`:**

```json
{
  "start": "POST /checkout",
  "max_depth": 8
}
```

**`codeatlas_source`:**

The tool enforces a response-size limit equal to `config.limits.maxSourceSnippetLines` (default: 120). This is the same limit applied to `source_snippets` in the Answer Packet. There is one limit; it is configured in one place.

**Standard pagination input (any tool returning node sets):**

```json
{
  "cursor": "string | null",
  "limit": 50
}
```

`limit` max is `config.limits.maxMcpResultNodes`. Cursor is an opaque string returned by the previous call's `pagination.cursor`. Null cursor means first page.

---

### §41 — Configuration (schema validation added)

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

**Validation behavior:** If `.codeatlas/config.json` fails JSON parsing or schema validation, CodeAtlas emits a structured error to stderr and exits with code 1. It does not fall back to defaults. Silent fallback masks accidental file truncation.

```
Error: .codeatlas/config.json is invalid.
  Line 4: "limits" must be an object.
Run `codeatlas doctor` for details.
```

---

### §45 — Performance Requirements (reference machine added)

Performance targets are defined against a **reference machine:**

```
CPU:     4-core x86-64
RAM:     16 GB
Storage: NVMe SSD
Runtime: Node.js current LTS
OS:      Linux or macOS
```

Targets:

| Repository size | Initial index target |
|---|---|
| < 50k LOC | < 10 seconds |
| ~100k LOC | < 30 seconds |
| ~500k LOC | < 2 minutes |

CI performance regression tests must use a fixture repository of known size and assert against these targets on equivalent hardware. Targets failing on significantly faster hardware indicate a regression.

---

### §48 — Concurrency (WAL mode made explicit)

The database must be opened in **WAL mode** unconditionally:

```sql
PRAGMA journal_mode=WAL;
```

WAL mode is required — not a performance preference — because it allows readers to proceed concurrently with the single active writer. Without it, the freshness-check-then-query sequence blocks under any concurrent MCP requests.

One write lock is held via `.codeatlas/lock` (a file lock using OS advisory locking). The MCP server acquires this lock for the duration of any incremental reindex. Graph queries do not require the write lock.

Incremental graph updates must occur in a single SQLite transaction. If the transaction fails, it is rolled back. The stored fingerprint is not updated on rollback.

---

### §71 — Implementation Order (revised)

#### Phase 1 — Foundation

Build: CLI scaffold, repository detection, config, schema validation, SQLite + WAL, migrations, file discovery, hashing, ignore rules, `.gitignore` integration.

Exit: `codeatlas init` creates a valid workspace. `codeatlas doctor` passes.

---

#### Phase 2 — Structural Indexer + Provenance

Implement: Tree-sitter, TypeScript/JavaScript/Python adapters, symbol extraction, imports, exports, classes, functions, methods.

**Provenance is built here, not later.** Every node and edge created in this phase must carry `source_type`, `confidence`, and `evidence`. No structural claim leaves the graph without a source location.

Exit: A fixture repository produces deterministic, evidence-annotated graph nodes.

---

#### Phase 3 — Relationship Resolution + MCP Skeleton

Implement: `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`, `REFERENCES` resolution. Ambiguous resolution emits all candidates with confidence scaled by import-graph distance.

**Also in this phase:** A functioning MCP server with all tools stubbed, returning typed empty responses. The MCP contract is now testable end-to-end even before full data is available. Schema validation tests can run from here.

Exit: Known fixture call graphs match expected snapshots. `codeatlas mcp` starts and responds to all tool calls.

---

#### Phase 4 — Incremental Indexing

Implement: Fingerprint computation, Git state, file hashes, dirty working tree, added/modified/deleted/renamed files, dependency-neighborhood invalidation.

Exit: Modifying a file updates only the required graph sections. Freshness test (§57) passes.

---

#### Phase 5 — Framework Adapters

Exit: Express, FastAPI, Prisma, SQLAlchemy create correct `api_route` and `database_model` nodes with evidence.

---

#### Phase 6 — Architecture Analysis

Implement: Feature detection, domain grouping, dependency communities, cycle detection, coupling metrics, hotspots.

Exit: `codeatlas_overview` and `codeatlas_health` return meaningful data on a medium-sized fixture repository.

---

#### Phase 7 — Hardening and Accuracy Verification

Run accuracy tests against fixture corpus (§61). Verify: no claim without evidence, file/line references are current-working-tree accurate, multi-candidate resolution is correct, deletion and rename tests pass (§57–§59).

Exit: All accuracy tests pass. No tool returns a structural claim without provenance.

---

#### Phase 8 — Packaging

Exit: External developer installs from README with no prior knowledge of the project.

---

## Summary of changes by section

| Section | Change |
|---|---|
| §17 | Rename similarity threshold pinned to Git's 50% default |
| §22 | String literal values explicitly excluded from storage |
| §24 | Fingerprint algorithm defined precisely |
| §25 | Non-Git support removed from MVP; Git requirement made unconditional |
| §35 | `from` → `start` in trace tool; source size limit coupled to config |
| §36 | `source_snippets`, `relationships`, `uncertainties`, `pagination` schemas defined |
| §41 | Config validation error behavior specified |
| §45 | Reference machine defined for performance targets |
| §48 | WAL mode made an explicit requirement |
| §71 | Phase 8 removed; provenance moved into Phase 2; MCP skeleton moved into Phase 3; phases renumbered |
