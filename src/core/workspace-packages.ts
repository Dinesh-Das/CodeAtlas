import { readFileSync } from "node:fs";
import path from "node:path";

interface RootPackageManifest {
  workspaces?: unknown;
}

function workspacePatterns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "object" && value !== null) {
    return workspacePatterns((value as { packages?: unknown }).packages);
  }
  return [];
}

function pnpmPatterns(content: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const match = /^-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/u.exec(line);
    if (match !== null) {
      patterns.push(match[1]!.trim());
      continue;
    }
    if (line !== "" && !line.startsWith("#")) break;
  }
  return patterns;
}

function globExpression(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//u, "").replace(/\/$/u, "");
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

/** Returns package manifests that are actual root/workspace members, not arbitrary nested packages. */
export function workspaceManifestPaths(
  repositoryRoot: string,
  indexedPaths: ReadonlySet<string>,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (indexedPaths.has("package.json")) result.add("package.json");

  const patterns: string[] = [];
  try {
    const root = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as RootPackageManifest;
    patterns.push(...workspacePatterns(root.workspaces));
  } catch {
    // Repositories without a valid root package may still use pnpm-workspace.yaml.
  }
  if (indexedPaths.has("pnpm-workspace.yaml")) {
    try {
      patterns.push(
        ...pnpmPatterns(
          readFileSync(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8"),
        ),
      );
    } catch {
      // Invalid workspace metadata is handled as ordinary repository content.
    }
  }

  const matchers = patterns
    .filter((pattern) => pattern.trim() !== "" && !pattern.trim().startsWith("!"))
    .map(globExpression);
  const exclusions = patterns
    .filter((pattern) => pattern.trim().startsWith("!"))
    .map((pattern) => globExpression(pattern.trim().slice(1)));
  for (const manifestPath of indexedPaths) {
    if (path.posix.basename(manifestPath) !== "package.json" || manifestPath === "package.json") {
      continue;
    }
    const directory = path.posix.dirname(manifestPath);
    if (
      matchers.some((matcher) => matcher.test(directory)) &&
      !exclusions.some((matcher) => matcher.test(directory))
    ) {
      result.add(manifestPath);
    }
  }
  return result;
}
