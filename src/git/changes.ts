import { toPosixPath } from "../core/paths.js";
import { runGit } from "./repository.js";

export type GitChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface GitChange {
  kind: GitChangeKind;
  path: string;
  previousPath: string | null;
  similarity: number | null;
  source: "history" | "working_tree" | "index" | "status";
}

export interface GitState {
  dirty: boolean;
  historyConsistent: boolean;
  changes: GitChange[];
  renames: Array<GitChange & { kind: "renamed"; previousPath: string; similarity: number }>;
}

function parseNameStatus(
  output: string,
  source: GitChange["source"],
): GitChange[] {
  const tokens = output.split("\0");
  const changes: GitChange[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    if (status === undefined || status === "") continue;
    const code = status[0];
    if (code === "R") {
      const previousPath = tokens[index++];
      const currentPath = tokens[index++];
      const similarity = Number.parseInt(status.slice(1), 10);
      if (previousPath !== undefined && currentPath !== undefined) {
        changes.push({
          kind: "renamed",
          path: toPosixPath(currentPath),
          previousPath: toPosixPath(previousPath),
          similarity: Number.isFinite(similarity) ? similarity / 100 : null,
          source,
        });
      }
      continue;
    }

    const filePath = tokens[index++];
    if (filePath === undefined || filePath === "") continue;
    const kind: GitChangeKind =
      code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    changes.push({
      kind,
      path: toPosixPath(filePath),
      previousPath: null,
      similarity: null,
      source,
    });
  }
  return changes;
}

function parsePorcelain(output: string): GitChange[] {
  const records = output.split("\0");
  const changes: GitChange[] = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index++];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = toPosixPath(record.slice(3));
    if (status.includes("R")) {
      const previousPath = records[index++];
      if (previousPath !== undefined) {
        changes.push({
          kind: "renamed",
          path: filePath,
          previousPath: toPosixPath(previousPath),
          similarity: null,
          source: "status",
        });
      }
    } else {
      const kind: GitChangeKind = status.includes("?")
        ? "added"
        : status.includes("A")
          ? "added"
          : status.includes("D")
            ? "deleted"
            : "modified";
      changes.push({
        kind,
        path: filePath,
        previousPath: null,
        similarity: null,
        source: "status",
      });
    }
  }
  return changes;
}

async function historyIsConsistent(
  repositoryRoot: string,
  baselineCommit: string | null,
  headCommit: string,
): Promise<boolean> {
  if (baselineCommit === null) return true;
  if (baselineCommit === headCommit) return true;
  if (baselineCommit === "unborn" || headCommit === "unborn") return false;
  try {
    await runGit(repositoryRoot, ["cat-file", "-e", `${baselineCommit}^{commit}`]);
    await runGit(repositoryRoot, ["merge-base", "--is-ancestor", baselineCommit, headCommit]);
    return true;
  } catch {
    return false;
  }
}

function deduplicateChanges(changes: readonly GitChange[]): GitChange[] {
  const result = new Map<string, GitChange>();
  for (const change of changes) {
    const key = `${change.kind}\0${change.previousPath ?? ""}\0${change.path}`;
    const existing = result.get(key);
    if (
      existing === undefined ||
      (change.similarity !== null &&
        (existing.similarity === null || change.similarity > existing.similarity))
    ) {
      result.set(key, change);
    }
  }
  return [...result.values()].sort((left, right) =>
    `${left.previousPath ?? ""}\0${left.path}\0${left.kind}`.localeCompare(
      `${right.previousPath ?? ""}\0${right.path}\0${right.kind}`,
    ),
  );
}

export async function detectGitState(
  repositoryRoot: string,
  baselineCommit: string | null,
  headCommit: string,
): Promise<GitState> {
  const historyConsistent = await historyIsConsistent(
    repositoryRoot,
    baselineCommit,
    headCommit,
  );
  const statusOutput = await runGit(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const collected: GitChange[] = parsePorcelain(statusOutput);

  if (historyConsistent && baselineCommit !== null && baselineCommit !== headCommit) {
    collected.push(
      ...parseNameStatus(
        await runGit(repositoryRoot, [
          "diff",
          "--name-status",
          "-z",
          "--find-renames=50%",
          baselineCommit,
          headCommit,
        ]),
        "history",
      ),
    );
  }

  if (headCommit !== "unborn") {
    const [workingTree, index] = await Promise.all([
      runGit(repositoryRoot, [
        "diff",
        "--name-status",
        "-z",
        "--find-renames=50%",
        "HEAD",
      ]),
      runGit(repositoryRoot, [
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "--find-renames=50%",
      ]),
    ]);
    collected.push(...parseNameStatus(workingTree, "working_tree"));
    collected.push(...parseNameStatus(index, "index"));
  }

  const changes = deduplicateChanges(collected);
  return {
    dirty: statusOutput.length > 0,
    historyConsistent,
    changes,
    renames: changes.filter(
      (change): change is GitChange & {
        kind: "renamed";
        previousPath: string;
        similarity: number;
      } =>
        change.kind === "renamed" &&
        change.previousPath !== null &&
        change.similarity !== null &&
        change.similarity >= 0.5 &&
        (change.source === "history" || change.source === "working_tree"),
    ),
  };
}
