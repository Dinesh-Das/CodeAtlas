import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const NETWORK_PATTERNS = [
  /from\s+["'](?:node:)?https?["']/u,
  /from\s+["'](?:axios|got|node-fetch|undici)["']/u,
  /\b(?:globalThis\.)?fetch\s*\(/u,
  /\bhttps?\.request\s*\(/u,
] as const;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  }));
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

describe("local-first privacy boundary", () => {
  it("contains no built-in outbound network transport in production source", async () => {
    const files = await sourceFiles(path.resolve("src"));
    const violations: string[] = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      for (const pattern of NETWORK_PATTERNS) {
        if (pattern.test(contents)) {
          violations.push(`${path.relative(process.cwd(), file)} matches ${pattern.source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
