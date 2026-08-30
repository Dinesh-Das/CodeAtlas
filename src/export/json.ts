import { mkdir } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hashing.js";
import { writeJsonAtomic, writeTextAtomic } from "../core/workspace.js";
import type { Atlas } from "../ir/models.js";
import { normalizeAtlas, serializeAtlas } from "../ir/serialization.js";

export interface JsonExportResult {
  files: string[];
  checksums: Record<string, string>;
}

function jsonLines(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + (values.length > 0 ? "\n" : "");
}

export async function exportAtlasData(atlas: Atlas, outputDirectory: string): Promise<JsonExportResult> {
  await mkdir(outputDirectory, { recursive: true });
  const normalized = normalizeAtlas(atlas);
  const contents: Record<string, string> = {
    "atlas.json": serializeAtlas(normalized),
    "symbols.jsonl": jsonLines(normalized.symbols),
    "relationships.jsonl": jsonLines(normalized.relationships),
    "flows.jsonl": jsonLines(normalized.flows),
    "domains.json": `${JSON.stringify(normalized.domains, null, 2)}\n`,
    "impact.json": `${JSON.stringify(normalized.impact, null, 2)}\n`,
    "evidence.json": `${JSON.stringify(normalized.evidence, null, 2)}\n`,
    "rules.json": `${JSON.stringify({ rules: normalized.rules, violations: normalized.rule_violations }, null, 2)}\n`,
    "review.json": `${JSON.stringify(normalized.review_findings, null, 2)}\n`,
  };
  await Promise.all(Object.entries(contents).map(([name, content]) =>
    writeTextAtomic(path.join(outputDirectory, name), content),
  ));
  const checksums = Object.fromEntries(
    Object.entries(contents).map(([name, content]) => [name, sha256(content)]),
  );
  const manifest = {
    schema_version: normalized.schema_version,
    snapshot_id: normalized.snapshot.id,
    project: normalized.project,
    statistics: normalized.statistics,
    files: Object.keys(contents).sort(),
    checksums,
  };
  await writeJsonAtomic(path.join(outputDirectory, "manifest.json"), manifest);
  return { files: [...Object.keys(contents), "manifest.json"].sort(), checksums };
}

export async function exportAtlasBundle(atlas: Atlas, outputDirectory: string): Promise<JsonExportResult> {
  return exportAtlasData(atlas, path.join(outputDirectory, "data"));
}
