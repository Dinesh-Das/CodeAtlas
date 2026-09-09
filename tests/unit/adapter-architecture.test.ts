import { describe, expect, it } from "vitest";
import { registerCodeAtlasLanguage } from "../../src/api.js";
import { detectLanguage, isSourceLanguage } from "../../src/core/languages.js";
import {
  availableFrameworkAdapters,
  extractFrameworkGraph,
  registerFrameworkAdapter,
} from "../../src/framework/registry.js";
import type { FrameworkAdapter } from "../../src/framework/types.js";
import type { LanguageAdapter } from "../../src/parser/parser.js";
import {
  availableLanguageAdapters,
  getLanguageAdapter,
  registerLanguageAdapter,
} from "../../src/parser/registry.js";

describe("language and framework adapter architecture", () => {
  it("uses tree-sitter as the baseline for every built-in source-language adapter", () => {
    const adapters = availableLanguageAdapters();
    expect(adapters.map((adapter) => adapter.language)).toEqual([
      "go",
      "java",
      "javascript",
      "jsx",
      "python",
      "rust",
      "tsx",
      "typescript",
    ]);
    for (const adapter of adapters) {
      expect(adapter.engine).toBe("tree-sitter");
      expect(adapter.createSyntaxTree("").type.length).toBeGreaterThan(0);
    }
  });

  it("allows a language adapter to be replaced temporarily and restores the built-in adapter", () => {
    const original = getLanguageAdapter("python");
    expect(original).not.toBeNull();
    const replacement: LanguageAdapter = {
      language: "python",
      version: "test-adapter-1",
      engine: "tree-sitter",
      createSyntaxTree: (content) => original!.createSyntaxTree(content),
      parseFile: (input) => original!.parseFile(input),
    };
    const unregister = registerLanguageAdapter("python", replacement, { replace: true });
    expect(getLanguageAdapter("python")).toBe(replacement);
    unregister();
    expect(getLanguageAdapter("python")).toBe(original);
  });

  it("exposes a public extension API for third-party source languages", () => {
    const baseline = getLanguageAdapter("python")!;
    const adapter: LanguageAdapter = {
      language: "example-language",
      version: "example-1",
      engine: "tree-sitter",
      createSyntaxTree: (content) => baseline.createSyntaxTree(content),
      parseFile: (input) => baseline.parseFile(input),
    };
    const unregister = registerCodeAtlasLanguage({
      language: "example-language",
      extensions: [".example"],
      adapter,
    });
    expect(detectLanguage("src/service.example")).toBe("example-language");
    expect(isSourceLanguage("example-language")).toBe(true);
    expect(getLanguageAdapter("example-language")).toBe(adapter);
    unregister();
    expect(detectLanguage("src/service.example")).toBeNull();
    expect(getLanguageAdapter("example-language")).toBeNull();
  });

  it("restores a replaced framework adapter when an extension is unregistered", () => {
    const original = availableFrameworkAdapters()[0]!;
    const replacement: FrameworkAdapter = {
      name: original.name,
      version: "test-framework-1",
      supports: () => false,
      detect: () => false,
      extractRoutes: () => [],
      extractModels: () => [],
      extractFrameworkRelationships: () => [],
    };
    const unregister = registerFrameworkAdapter(replacement, { replace: true });
    expect(availableFrameworkAdapters().find((adapter) => adapter.name === original.name)).toBe(replacement);
    unregister();
    expect(availableFrameworkAdapters().find((adapter) => adapter.name === original.name)).toBe(original);
  });

  it("isolates framework facts that violate the runtime evidence contract", () => {
    const malformed: FrameworkAdapter = {
      name: "malformed-contract-fixture",
      version: "1",
      supports: (file) => file === "fixture.bad",
      detect: () => true,
      extractRoutes: () => [{
        id: "bad-node",
        kind: "api_route",
        name: "bad",
        qualifiedName: "bad",
        filePath: "fixture.bad",
        language: null,
        startLine: 1,
        startColumn: 0,
        endLine: 1,
        endColumn: 1,
        signature: null,
        visibility: null,
        contentHash: "hash",
        sourceType: "framework",
        provenance: "verified",
        confidence: 2,
        metadata: { evidence: { source_type: "framework", file: "fixture.bad", line: 1, column: 0 } },
      }],
      extractModels: () => [],
      extractFrameworkRelationships: () => [],
    };
    const unregister = registerFrameworkAdapter(malformed);
    try {
      const extraction = extractFrameworkGraph({
        repositoryId: "repo",
        repositoryRoot: ".",
        relativeFilePath: "fixture.bad",
        language: null,
        content: "fixture",
        contentHash: "hash",
        parsedFile: null,
      });
      expect(extraction.nodes).toEqual([]);
      expect(extraction.detectedFrameworks).toEqual([]);
      expect(extraction.failures).toEqual([{
        adapter: "malformed-contract-fixture",
        message: "malformed-contract-fixture node 0 confidence must be between 0 and 1.",
      }]);
    } finally {
      unregister();
    }
  });
});
