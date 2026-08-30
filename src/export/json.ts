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

const BUNDLE_SHARD_SIZE = 1_000;

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
  const dataDirectory = path.join(outputDirectory, "data");
  await mkdir(dataDirectory, { recursive: true });
  const normalized = normalizeAtlas(atlas);
  const contents: Record<string, string> = {
    "atlas.json": serializeAtlas(normalized),
    "domains.json": `${JSON.stringify(normalized.domains, null, 2)}\n`,
    "impact.json": `${JSON.stringify(normalized.impact, null, 2)}\n`,
    "rules.json": `${JSON.stringify({ rules: normalized.rules, violations: normalized.rule_violations }, null, 2)}\n`,
    "review.json": `${JSON.stringify(normalized.review_findings, null, 2)}\n`,
  };
  const shards: Record<string, string[]> = {};
  const addShards = (name: string, values: readonly unknown[]): void => {
    const files: string[] = [];
    const shardCount = Math.max(1, Math.ceil(values.length / BUNDLE_SHARD_SIZE));
    for (let index = 0; index < shardCount; index += 1) {
      const file = `${name}-${String(index + 1).padStart(3, "0")}.json`;
      const chunk = values.slice(index * BUNDLE_SHARD_SIZE, (index + 1) * BUNDLE_SHARD_SIZE);
      contents[file] = `${JSON.stringify(chunk, null, 2)}\n`;
      files.push(file);
    }
    shards[name] = files;
  };
  addShards("symbols", normalized.symbols);
  addShards("relationships", normalized.relationships);
  addShards("flows", normalized.flows);
  addShards("control-flows", normalized.control_flows);
  addShards("evidence", normalized.evidence);
  addShards("git-changes", normalized.git_changes);

  await Promise.all(Object.entries(contents).map(([name, content]) =>
    writeTextAtomic(path.join(dataDirectory, name), content),
  ));
  const checksums = Object.fromEntries(
    Object.entries(contents).map(([name, content]) => [name, sha256(content)]),
  );
  const manifest = {
    schema_version: normalized.schema_version,
    snapshot_id: normalized.snapshot.id,
    project: normalized.project,
    statistics: normalized.statistics,
    shard_size: BUNDLE_SHARD_SIZE,
    shards,
    files: Object.keys(contents).sort(),
    checksums,
  };
  await writeJsonAtomic(path.join(dataDirectory, "manifest.json"), manifest);
  return { files: [...Object.keys(contents), "manifest.json"].sort(), checksums };
}
