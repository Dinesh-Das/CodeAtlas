import type { IndexProgress } from "../core/telemetry.js";

const PHASE_LABELS: Partial<Record<IndexProgress["phase"], string>> = {
  index_lock_wait: "waiting for active index",
  tree_sitter_parsing: "tree sitter parsing",
};

export function createIndexProgressReporter(
  stream: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stderr,
): (progress: IndexProgress) => void {
  return (progress): void => {
    if (progress.status === "completed" && progress.elapsedMs === 0) return;
    const label = PHASE_LABELS[progress.phase] ?? progress.phase.replaceAll("_", " ");
    const count = progress.total === null || progress.total === 0
      ? ""
      : ` ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}`;
    const elapsed = progress.status === "started"
      ? ""
      : ` ${(progress.elapsedMs / 1_000).toFixed(2)}s`;
    if (stream.isTTY && progress.status !== "completed") {
      stream.write(`\r${label}${count}${elapsed}`);
    } else if (progress.status === "completed") {
      if (stream.isTTY) stream.write("\r\x1b[2K");
      stream.write(`${label}${count}${elapsed}\n`);
    }
  };
}
