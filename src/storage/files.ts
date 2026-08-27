import type { AtlasDatabase } from "./database.js";

export interface FileRecord {
  path: string;
  language: string | null;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number | null;
  ctimeMs: number | null;
  parserVersion: string;
  adapterVersion: string;
  indexedCommit: string;
  parseStatus: string;
  indexedAt: string;
}

export function listFiles(database: AtlasDatabase): FileRecord[] {
  return database
    .prepare(
      `SELECT
        path,
        language,
        content_hash AS contentHash,
        size_bytes AS sizeBytes,
        mtime_ms AS mtimeMs,
        ctime_ms AS ctimeMs,
        parser_version AS parserVersion,
        adapter_version AS adapterVersion,
        indexed_commit AS indexedCommit,
        parse_status AS parseStatus,
        indexed_at AS indexedAt
      FROM files
      ORDER BY path`,
    )
    .all() as FileRecord[];
}

export function upsertFile(database: AtlasDatabase, record: FileRecord): void {
  database
    .prepare(
      `INSERT INTO files(
        path, language, content_hash, size_bytes, mtime_ms, ctime_ms,
        parser_version, adapter_version,
        indexed_commit, parse_status, indexed_at
      ) VALUES (
        @path, @language, @contentHash, @sizeBytes, @mtimeMs, @ctimeMs,
        @parserVersion, @adapterVersion,
        @indexedCommit, @parseStatus, @indexedAt
      )
      ON CONFLICT(path) DO UPDATE SET
        language = excluded.language,
        content_hash = excluded.content_hash,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        ctime_ms = excluded.ctime_ms,
        parser_version = excluded.parser_version,
        adapter_version = excluded.adapter_version,
        indexed_commit = excluded.indexed_commit,
        parse_status = excluded.parse_status,
        indexed_at = excluded.indexed_at`,
    )
    .run(record);
}

export function deleteFile(database: AtlasDatabase, relativeFilePath: string): void {
  database.prepare("DELETE FROM files WHERE path = ?").run(relativeFilePath);
}
