import { describe, expect, it } from "vitest";
import { validateReleaseArtifact } from "../../src/release/evidence.js";

const version = "1.0.0-beta.1";
const artifact = {
  codeAtlasVersion: version,
  packageSha256: "a".repeat(64),
  packedFileCount: 500,
};

describe("release artifact identity", () => {
  it("accepts a matching prerelease artifact without stable evaluation evidence", () => {
    expect(validateReleaseArtifact(version, artifact, artifact)).toEqual([]);
  });

  it("rejects a changed prerelease tarball before it can be published", () => {
    expect(validateReleaseArtifact(version, artifact, {
      ...artifact,
      packageSha256: "b".repeat(64),
      packedFileCount: 501,
    })).toEqual(expect.arrayContaining([
      expect.stringContaining("SHA-256"),
      expect.stringContaining("file count"),
    ]));
  });

  it("rejects a manifest or produced package from another version", () => {
    expect(validateReleaseArtifact(version, {
      ...artifact,
      codeAtlasVersion: "1.0.0-beta.0",
    }, { ...artifact, codeAtlasVersion: "1.0.0" })).toEqual(expect.arrayContaining([
      expect.stringContaining("Release artifact reports 1.0.0-beta.0"),
      expect.stringContaining("Produced package reports 1.0.0"),
    ]));
  });

  it("rejects missing or malformed identity evidence", () => {
    expect(validateReleaseArtifact(version, undefined, artifact).length).toBeGreaterThan(0);
    expect(validateReleaseArtifact(version, {
      ...artifact,
      packageSha256: "invalid",
    }, artifact).length).toBeGreaterThan(0);
  });
});
