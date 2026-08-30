import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildRepository } from "../compiler/build.js";
import type { Atlas } from "../ir/models.js";

export async function checkRepository(startPath = process.cwd()): Promise<{
  atlas: Atlas;
  blocking: number;
}> {
  const build = await buildRepository(startPath, { snapshot: false });
  const atlas = JSON.parse(await readFile(path.join(build.currentDirectory, "atlas.json"), "utf8")) as Atlas;
  return {
    atlas,
    blocking: atlas.rule_violations.filter((violation) => violation.severity === "error").length,
  };
}

export function formatCheckResult(result: Awaited<ReturnType<typeof checkRepository>>): string {
  if (result.atlas.rules.length === 0) return "[OK] No architecture rules are configured.";
  const lines = result.atlas.rule_violations.map((violation) =>
    `[${violation.severity.toUpperCase()}] ${violation.rule_id}: ${violation.message}`,
  );
  return [
    `[OK] Evaluated ${result.atlas.rules.length} architecture rules`,
    ...lines,
    result.blocking > 0
      ? `[ERROR] ${result.blocking} blocking violations`
      : "[OK] No blocking architecture violations",
  ].join("\n");
}
