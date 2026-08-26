import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { toPosixPath } from "./paths.js";

const DEFAULT_IGNORES = [
  ".git/",
  ".codeatlas/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  "venv/",
  ".venv/",
  "__pycache__/",
  "vendor/",
  "target/",
];

const SECRET_IGNORES = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
  "credentials.*",
];

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export interface IgnoreRules {
  ignores(relativePath: string, isDirectory?: boolean): boolean;
}

export async function loadIgnoreRules(repositoryRoot: string): Promise<IgnoreRules> {
  interface ScopedMatcher {
    base: string;
    matcher: Ignore;
  }

  const codeatlasignore = await readOptional(path.join(repositoryRoot, ".codeatlasignore"));
  const policyMatcher = ignore().add(codeatlasignore).add(DEFAULT_IGNORES).add(SECRET_IGNORES);
  const gitMatchers: ScopedMatcher[] = [];

  const rules: IgnoreRules = {
    ignores(relativeFilePath: string, isDirectory = false): boolean {
      const normalized = toPosixPath(relativeFilePath).replace(/^\.\//, "").replace(/\/$/u, "");
      if (normalized === "") return false;
      const candidate = isDirectory ? `${normalized}/` : normalized;
      let ignored = false;

      for (const scoped of gitMatchers) {
        if (scoped.base !== "" && normalized !== scoped.base && !normalized.startsWith(`${scoped.base}/`)) {
          continue;
        }
        const scopedPath = scoped.base === "" ? candidate : candidate.slice(scoped.base.length + 1);
        if (scopedPath === "") continue;
        const result = scoped.matcher.test(scopedPath);
        if (result.ignored) ignored = true;
        if (result.unignored) ignored = false;
      }

      return ignored || policyMatcher.ignores(candidate);
    },
  };

  async function loadGitignoreTree(directory: string, base: string): Promise<void> {
    const contents = await readOptional(path.join(directory, ".gitignore"));
    if (contents.length > 0) gitMatchers.push({ base, matcher: ignore().add(contents) });

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relative = base === "" ? entry.name : `${base}/${entry.name}`;
      if (!rules.ignores(relative, true)) {
        await loadGitignoreTree(path.join(directory, entry.name), relative);
      }
    }
  }

  await loadGitignoreTree(repositoryRoot, "");
  return rules;
}

export async function ensureCodeAtlasIgnored(repositoryRoot: string): Promise<boolean> {
  const filePath = path.join(repositoryRoot, ".gitignore");
  const current = await readOptional(filePath);
  const alreadyPresent = current
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some((line) => line === ".codeatlas/" || line === "/.codeatlas/" || line === ".codeatlas");

  if (alreadyPresent) return false;

  const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(filePath, `${prefix}.codeatlas/\n`, "utf8"),
  );
  return true;
}
