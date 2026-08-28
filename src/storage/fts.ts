import type { AtlasDatabase } from "./database.js";

export function suspendNodeSearchSync(database: AtlasDatabase): void {
  database.exec(`
    DROP TRIGGER IF EXISTS nodes_fts_insert;
    DROP TRIGGER IF EXISTS nodes_fts_delete;
    DROP TRIGGER IF EXISTS nodes_fts_update;
  `);
}

export function rebuildNodeSearch(database: AtlasDatabase): void {
  database.exec(`
    INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild');

    CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(
        rowid, name, qualified_name, file_path, signature, metadata_json
      ) VALUES (
        new.rowid, new.name, coalesce(new.qualified_name, ''),
        coalesce(new.file_path, ''), coalesce(new.signature, ''),
        coalesce(new.metadata_json, '')
      );
    END;

    CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(
        nodes_fts, rowid, name, qualified_name, file_path, signature, metadata_json
      ) VALUES (
        'delete', old.rowid, old.name, coalesce(old.qualified_name, ''),
        coalesce(old.file_path, ''), coalesce(old.signature, ''),
        coalesce(old.metadata_json, '')
      );
    END;

    CREATE TRIGGER nodes_fts_update AFTER UPDATE ON nodes BEGIN
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
  `);
}
