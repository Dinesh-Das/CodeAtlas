import { buildRepository } from "../compiler/build.js";
import { loadCurrentAtlas } from "./v2-query.js";

export async function reviewRepository(
  startPath = process.cwd(),
  base = "HEAD",
  head = "HEAD",
) {
  await buildRepository(startPath, { gitBase: base, gitHead: head });
  const atlas = await loadCurrentAtlas(startPath);
  return {
    base,
    head,
    changes: atlas.git_changes,
    violations: atlas.rule_violations,
    findings: atlas.review_findings,
  };
}

export function formatReviewResult(result: Awaited<ReturnType<typeof reviewRepository>>): string {
  const counts = (severity: string): number => result.findings.filter((finding) => finding.severity === severity).length;
  return [
    `Review ${result.base}..${result.head}`,
    "",
    `Changed: ${result.changes.length} files`,
    `Architecture: ${result.violations.length} rule violations`,
    `Review: ${counts("critical")} critical, ${counts("high")} high, ${counts("medium")} medium, ${counts("low")} low`,
    ...result.findings.map((finding) =>
      `[${finding.severity.toUpperCase()}] ${finding.title}\n  ${finding.description}`,
    ),
  ].join("\n");
}
