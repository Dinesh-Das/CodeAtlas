import { toPosixPath } from "../core/paths.js";
import { runGit } from "./repository.js";

export interface FileHistorySummary {
  recentCommitCount: number;
  recentChurn: number;
  contributorCount: number;
  lastModifiedCommit: string | null;
  lastModifiedDate: string | null;
}

interface MutableHistory {
  commits: Set<string>;
  churn: number;
  contributors: Set<string>;
  lastModifiedCommit: string | null;
  lastModifiedDate: string | null;
}

export async function collectRecentFileHistory(
  repositoryRoot: string,
  currentPaths: ReadonlySet<string>,
): Promise<Map<string, FileHistorySummary>> {
  const output = await runGit(
    repositoryRoot,
    [
      "-c",
      "core.quotepath=false",
      "log",
      "--since=90.days",
      "--max-count=500",
      "--format=@@%H%x09%aI%x09%aN",
      "--numstat",
      "--no-renames",
      "--",
      ".",
    ],
    true,
  );
  const mutable = new Map<string, MutableHistory>();
  let commit = "";
  let date = "";
  let contributor = "";
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("@@")) {
      const parts = line.slice(2).split("\t");
      commit = parts[0] ?? "";
      date = parts[1] ?? "";
      contributor = parts.slice(2).join("\t");
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(line);
    if (match === null || commit === "") continue;
    const filePath = toPosixPath(match[3]!);
    if (!currentPaths.has(filePath)) continue;
    const history = mutable.get(filePath) ?? {
      commits: new Set<string>(),
      churn: 0,
      contributors: new Set<string>(),
      lastModifiedCommit: null,
      lastModifiedDate: null,
    };
    history.commits.add(commit);
    if (contributor !== "") history.contributors.add(contributor);
    history.churn +=
      (match[1] === "-" ? 0 : Number.parseInt(match[1]!, 10)) +
      (match[2] === "-" ? 0 : Number.parseInt(match[2]!, 10));
    if (history.lastModifiedCommit === null) {
      history.lastModifiedCommit = commit;
      history.lastModifiedDate = date || null;
    }
    mutable.set(filePath, history);
  }

  return new Map(
    [...mutable].map(([filePath, history]) => [
      filePath,
      {
        recentCommitCount: history.commits.size,
        recentChurn: history.churn,
        contributorCount: history.contributors.size,
        lastModifiedCommit: history.lastModifiedCommit,
        lastModifiedDate: history.lastModifiedDate,
      },
    ]),
  );
}
