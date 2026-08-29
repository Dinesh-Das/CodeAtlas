import type Database from "better-sqlite3";
import { SCHEMA_VERSION } from "../version.js";

interface Migration {
  version: number;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
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
        FOREIGN KEY(source_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(target_node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

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

      CREATE TABLE repository_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX idx_nodes_kind ON nodes(kind);
      CREATE INDEX idx_nodes_file_path ON nodes(file_path);
      CREATE INDEX idx_nodes_qualified_name ON nodes(qualified_name);
      CREATE INDEX idx_edges_source ON edges(source_node_id);
      CREATE INDEX idx_edges_target ON edges(target_node_id);
      CREATE INDEX idx_edges_type ON edges(edge_type);

      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        id UNINDEXED,
        name,
        qualified_name,
        file_path,
        signature,
        metadata
      );

      CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(id, name, qualified_name, file_path, signature, metadata)
        VALUES (
          new.id,
          new.name,
          coalesce(new.qualified_name, ''),
          coalesce(new.file_path, ''),
          coalesce(new.signature, ''),
          coalesce(new.metadata_json, '')
        );
      END;

      CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes BEGIN
        DELETE FROM nodes_fts WHERE id = old.id;
      END;

      CREATE TRIGGER nodes_fts_update AFTER UPDATE ON nodes BEGIN
        DELETE FROM nodes_fts WHERE id = old.id;
        INSERT INTO nodes_fts(id, name, qualified_name, file_path, signature, metadata)
        VALUES (
          new.id,
          new.name,
          coalesce(new.qualified_name, ''),
          coalesce(new.file_path, ''),
          coalesce(new.signature, ''),
          coalesce(new.metadata_json, '')
        );
      END;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE resolution_issues (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL,
        reference_kind TEXT NOT NULL,
        reference_name TEXT,
        reference_hash TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        column_number INTEGER NOT NULL,
        reason TEXT NOT NULL,
        candidate_node_ids_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(source_node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_resolution_issues_source ON resolution_issues(source_node_id);
      CREATE INDEX idx_resolution_issues_file ON resolution_issues(file_path);
      CREATE INDEX idx_resolution_issues_reason ON resolution_issues(reason);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE architecture_metrics (
        file_node_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        fan_in INTEGER NOT NULL,
        fan_out INTEGER NOT NULL,
        dependency_depth INTEGER NOT NULL,
        cross_domain_dependencies INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        recent_commit_count INTEGER NOT NULL,
        recent_churn INTEGER NOT NULL,
        contributor_count INTEGER NOT NULL,
        hotspot_score REAL NOT NULL,
        last_modified_commit TEXT,
        last_modified_date TEXT,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(file_node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE TABLE architecture_findings (
        id TEXT PRIMARY KEY,
        finding_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_node_ids_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE dependency_communities (
        community_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        member_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(community_id, node_id),
        FOREIGN KEY(node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_architecture_metrics_hotspot
        ON architecture_metrics(hotspot_score DESC);
      CREATE INDEX idx_architecture_findings_type
        ON architecture_findings(finding_type, severity);
      CREATE INDEX idx_dependency_communities_file
        ON dependency_communities(file_path);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE nodes
        ADD COLUMN provenance_category TEXT NOT NULL DEFAULT 'verified';
      ALTER TABLE edges
        ADD COLUMN provenance_category TEXT NOT NULL DEFAULT 'verified';
      ALTER TABLE files ADD COLUMN mtime_ms REAL;
      ALTER TABLE files ADD COLUMN ctime_ms REAL;

      UPDATE nodes SET provenance_category = CASE source_type
        WHEN 'heuristic' THEN 'inferred'
        WHEN 'documentation' THEN 'documentation'
        WHEN 'git' THEN 'git'
        ELSE 'verified'
      END;
      UPDATE edges SET provenance_category = CASE source_type
        WHEN 'heuristic' THEN 'inferred'
        WHEN 'documentation' THEN 'documentation'
        WHEN 'git' THEN 'git'
        ELSE 'verified'
      END;

      CREATE INDEX idx_nodes_provenance ON nodes(provenance_category);
      CREATE INDEX idx_edges_provenance ON edges(provenance_category);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE INDEX idx_nodes_name_nocase ON nodes(name COLLATE NOCASE);
      CREATE INDEX idx_nodes_qualified_name_nocase
        ON nodes(qualified_name COLLATE NOCASE);
      CREATE INDEX idx_nodes_kind_name ON nodes(kind, name);
      CREATE INDEX idx_edges_type_source ON edges(edge_type, source_node_id);
      CREATE INDEX idx_edges_type_target ON edges(edge_type, target_node_id);
      CREATE INDEX idx_edges_file_path ON edges(file_path);
      CREATE INDEX idx_resolution_issues_source_reason
        ON resolution_issues(source_node_id, reason);
    `,
  },
  {
    version: 6,
    sql: `
      DROP TRIGGER nodes_fts_insert;
      DROP TRIGGER nodes_fts_delete;
      DROP TRIGGER nodes_fts_update;
      DROP TABLE nodes_fts;

      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        name,
        qualified_name,
        file_path,
        signature,
        metadata_json,
        content = 'nodes',
        content_rowid = 'rowid'
      );

      CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(
          rowid, name, qualified_name, file_path, signature, metadata_json
        ) VALUES (
          new.rowid,
          new.name,
          coalesce(new.qualified_name, ''),
          coalesce(new.file_path, ''),
          coalesce(new.signature, ''),
          coalesce(new.metadata_json, '')
        );
      END;

      CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(
          nodes_fts, rowid, name, qualified_name, file_path, signature, metadata_json
        ) VALUES (
          'delete',
          old.rowid,
          old.name,
          coalesce(old.qualified_name, ''),
          coalesce(old.file_path, ''),
          coalesce(old.signature, ''),
          coalesce(old.metadata_json, '')
        );
      END;

      CREATE TRIGGER nodes_fts_update AFTER UPDATE ON nodes BEGIN
        INSERT INTO nodes_fts(
          nodes_fts, rowid, name, qualified_name, file_path, signature, metadata_json
        ) VALUES (
          'delete',
          old.rowid,
          old.name,
          coalesce(old.qualified_name, ''),
          coalesce(old.file_path, ''),
          coalesce(old.signature, ''),
          coalesce(old.metadata_json, '')
        );
        INSERT INTO nodes_fts(
          rowid, name, qualified_name, file_path, signature, metadata_json
        ) VALUES (
          new.rowid,
          new.name,
          coalesce(new.qualified_name, ''),
          coalesce(new.file_path, ''),
          coalesce(new.signature, ''),
          coalesce(new.metadata_json, '')
        );
      END;

      INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild');
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE file_semantics (
        path TEXT PRIMARY KEY,
        token_fingerprint TEXT NOT NULL,
        symbols_fingerprint TEXT NOT NULL,
        imports_fingerprint TEXT NOT NULL,
        exports_fingerprint TEXT NOT NULL,
        references_fingerprint TEXT NOT NULL,
        public_api_fingerprint TEXT NOT NULL,
        framework_fingerprint TEXT NOT NULL,
        architecture_fingerprint TEXT NOT NULL,
        search_fingerprint TEXT NOT NULL,
        exported_symbols_json TEXT NOT NULL,
        references_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(path) REFERENCES files(path) ON DELETE CASCADE
      );

      CREATE TABLE resolved_edges (
        file_path TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        PRIMARY KEY(file_path, edge_id),
        FOREIGN KEY(edge_id) REFERENCES edges(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_resolved_edges_file ON resolved_edges(file_path);

      CREATE TABLE file_git_history (
        file_path TEXT PRIMARY KEY,
        recent_commit_count INTEGER NOT NULL,
        recent_churn INTEGER NOT NULL,
        contributor_count INTEGER NOT NULL,
        last_modified_commit TEXT,
        last_modified_date TEXT
      );

      DROP TRIGGER nodes_fts_update;
      CREATE TRIGGER nodes_fts_update
      AFTER UPDATE OF name, qualified_name, file_path, signature, metadata_json ON nodes
      WHEN old.name IS NOT new.name
        OR old.qualified_name IS NOT new.qualified_name
        OR old.file_path IS NOT new.file_path
        OR old.signature IS NOT new.signature
        OR old.metadata_json IS NOT new.metadata_json
      BEGIN
        INSERT INTO nodes_fts(
          nodes_fts, rowid, name, qualified_name, file_path, signature, metadata_json
        ) VALUES (
          'delete', old.rowid, old.name, coalesce(old.qualified_name, ''),
          coalesce(old.file_path, ''), coalesce(old.signature, ''),
          coalesce(old.metadata_json, '')
        );
        INSERT INTO nodes_fts(
          rowid, name, qualified_name, file_path, signature, metadata_json
        ) VALUES (
          new.rowid, new.name, coalesce(new.qualified_name, ''),
          coalesce(new.file_path, ''), coalesce(new.signature, ''),
          coalesce(new.metadata_json, '')
        );
      END;
    `,
  },
  {
    version: 8,
    sql: `
      CREATE INDEX idx_resolution_issues_import_hash
        ON resolution_issues(reference_kind, reason, reference_hash, file_path);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE INDEX idx_resolved_edges_edge ON resolved_edges(edge_id);
      CREATE INDEX idx_dependency_communities_node ON dependency_communities(node_id);
    `,
  },
];

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const migrate = database.transaction(() => {
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    }
  });
  migrate();

  const currentVersion = database
    .prepare("SELECT max(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  if (currentVersion.version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported CodeAtlas schema version ${currentVersion.version ?? "none"}; expected ${SCHEMA_VERSION}.`,
    );
  }
}
