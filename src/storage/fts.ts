import type { AtlasDatabase } from "./database.js";

const SEARCH_COLUMNS_CHANGED = `
  old.name IS NOT new.name OR
  old.qualified_name IS NOT new.qualified_name OR
  old.file_path IS NOT new.file_path OR
  old.signature IS NOT new.signature OR
  old.metadata_json IS NOT new.metadata_json
`;

export interface NodeSearchMutationObserver {
  finish(): number;
}

/** Counts logical FTS document writes without adding persistence mutations. */
export function observeNodeSearchMutations(
  database: AtlasDatabase,
): NodeSearchMutationObserver {
  let mutations = 0;
  database.function("codeatlas_count_fts_mutation", () => {
    mutations += 1;
    return mutations;
  });
  database.exec(`
    CREATE TEMP TRIGGER codeatlas_count_nodes_fts_insert
    AFTER INSERT ON nodes BEGIN
      SELECT codeatlas_count_fts_mutation();
    END;
    CREATE TEMP TRIGGER codeatlas_count_nodes_fts_delete
    AFTER DELETE ON nodes BEGIN
      SELECT codeatlas_count_fts_mutation();
    END;
    CREATE TEMP TRIGGER codeatlas_count_nodes_fts_update
    AFTER UPDATE OF name, qualified_name, file_path, signature, metadata_json ON nodes
    WHEN ${SEARCH_COLUMNS_CHANGED}
    BEGIN
      SELECT codeatlas_count_fts_mutation();
    END;
  `);
  return {
    finish() {
      database.exec(`
        DROP TRIGGER IF EXISTS codeatlas_count_nodes_fts_insert;
        DROP TRIGGER IF EXISTS codeatlas_count_nodes_fts_delete;
        DROP TRIGGER IF EXISTS codeatlas_count_nodes_fts_update;
      `);
      return mutations;
    },
  };
}

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

    CREATE TRIGGER nodes_fts_update
    AFTER UPDATE OF name, qualified_name, file_path, signature, metadata_json ON nodes
    WHEN ${SEARCH_COLUMNS_CHANGED}
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
  `);
}
