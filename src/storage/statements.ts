import type { AtlasDatabase } from "./database.js";

type PreparedStatement = ReturnType<AtlasDatabase["prepare"]>;

const statementsByDatabase = new WeakMap<AtlasDatabase, Map<string, PreparedStatement>>();

/** Reuse hot prepared statements for the lifetime of one database connection. */
export function cachedStatement(database: AtlasDatabase, sql: string): PreparedStatement {
  let statements = statementsByDatabase.get(database);
  if (statements === undefined) {
    statements = new Map();
    statementsByDatabase.set(database, statements);
  }
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = database.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}
