import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { classifyArchitecturalScope } from "../../src/analysis/scope.js";

const execFile = promisify(execFileCallback);

describe("architectural test scope", () => {
  it.each([
    ["src/checkout.spec.ts", "test"],
    ["src/checkout.test-d.ts", "test"],
    ["test_checkout.py", "test"],
    ["spec.checkout.ts", "test"],
    ["tests/fixtures/checkout.test.ts", "fixture"],
    ["src/checkout.spec.ts/entry.ts", "production"],
    ["src/checkout.spec.", "production"],
  ])("classifies %s as %s", (file, scope) => {
    expect(classifyArchitecturalScope(file)).toBe(scope);
  });

  it("bounds classification time for repeated test markers in directory names", async () => {
    const script = String.raw`
      const { classifyArchitecturalScope } = await import(process.argv[1]);
      for (const marker of ['.spec.', '.test.']) {
        console.log(classifyArchitecturalScope(marker.repeat(50_000) + '/entry.ts'));
      }
    `;
    const result = await execFile(process.execPath, [
      "--input-type=module", "--eval", script,
      pathToFileURL(path.resolve("dist/analysis/scope.js")).href,
    ], { windowsHide: true, timeout: 3_000 });
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual(["production", "production"]);
  });
});
