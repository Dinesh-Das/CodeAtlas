import { describe, expect, it } from "vitest";
import { normalizeV2Config, parseCodeAtlasYaml } from "../../src/rules/config.js";

describe(".codeatlas.yml", () => {
  it("parses domain overrides and nested architecture rules", () => {
    const config = normalizeV2Config(parseCodeAtlasYaml(`
version: 1
domains:
  authentication:
    include:
      - src/auth/**
architecture:
  rules:
    - id: no-controller-repository
      severity: error
      source:
        layer: controller
      forbid:
        calls:
          layer: repository
`));
    expect(config.domains.authentication?.include).toEqual(["src/auth/**"]);
    expect(config.architecture.rules).toEqual([
      expect.objectContaining({
        id: "no-controller-repository",
        severity: "error",
        source: { layer: "controller" },
        forbid: { calls: { layer: "repository" } },
      }),
    ]);
  });
});
