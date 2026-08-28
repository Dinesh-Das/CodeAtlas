import type { FileHistorySummary } from "../git/history.js";
import type { AtlasDatabase } from "./database.js";

export function loadGitHistoryCache(
  database: AtlasDatabase,
): Map<string, FileHistorySummary> {
  const rows = database
    .prepare(
      `SELECT file_path, recent_commit_count, recent_churn, contributor_count,
              last_modified_commit, last_modified_date
       FROM file_git_history ORDER BY file_path`,
    )
    .all() as Array<{
      file_path: string;
      recent_commit_count: number;
      recent_churn: number;
      contributor_count: number;
      last_modified_commit: string | null;
      last_modified_date: string | null;
    }>;
  return new Map(rows.map((row) => [row.file_path, {
    recentCommitCount: row.recent_commit_count,
    recentChurn: row.recent_churn,
    contributorCount: row.contributor_count,
    lastModifiedCommit: row.last_modified_commit,
    lastModifiedDate: row.last_modified_date,
  }]));
}

export function replaceGitHistoryCache(
  database: AtlasDatabase,
  history: ReadonlyMap<string, FileHistorySummary>,
): void {
  const replace = database.transaction(() => {
    database.prepare("DELETE FROM file_git_history").run();
    const insert = database.prepare(
      `INSERT INTO file_git_history(
         file_path, recent_commit_count, recent_churn, contributor_count,
         last_modified_commit, last_modified_date
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [filePath, entry] of history) {
      insert.run(
        filePath,
        entry.recentCommitCount,
        entry.recentChurn,
        entry.contributorCount,
        entry.lastModifiedCommit,
        entry.lastModifiedDate,
      );
    }
  });
  replace();
}
