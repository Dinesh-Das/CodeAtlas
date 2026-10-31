import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initializeRepository } from "../dist/cli/init.js";
import { compactChangeContext, expandCompactContext } from "../dist/context/compact.js";
import { compileChangeContext } from "../dist/context/planner.js";
import { serializeChangeContext, validateChangeContextGrounding } from "../dist/context/packet.js";
import { evaluationSuiteSchema } from "../dist/evaluation/models.js";
import { validatePinnedFixtures } from "../dist/evaluation/runner.js";
import { CODEATLAS_VERSION } from "../dist/version.js";

const options = new Map();
const allowed = new Set(["--suite", "--output", "--budget", "--tokenizer", "--tokenizer-id", "--encoding"]);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!allowed.has(key) || value === undefined || value.startsWith("--")) throw new Error(`Invalid option ${key}.`);
  options.set(key, value);
}
const budget = Number(options.get("--budget") ?? 6_000);
if (!Number.isInteger(budget) || budget < 3_000 || budget > 100_000) throw new Error("Budget must be 3000–100000 UTF-8 bytes.");
const workspaceRoot = process.cwd();
const suite = evaluationSuiteSchema.parse(JSON.parse(await readFile(path.resolve(options.get("--suite") ?? "evals/development.json"), "utf8")));
const fixtureErrors = await validatePinnedFixtures(suite, workspaceRoot);
if (fixtureErrors.length > 0) throw new Error(JSON.stringify(fixtureErrors));
const tokenizerPath = options.get("--tokenizer");
const encodingName = options.get("--encoding") ?? "o200k_base";
if (tokenizerPath !== undefined && !options.has("--tokenizer-id")) throw new Error("Supply --tokenizer-id with the exact tokenizer package version.");
const tokenizer = tokenizerPath === undefined ? null : (await import(pathToFileURL(path.resolve(tokenizerPath)).href)).getEncoding(encodingName);
const measure = (text) => ({
  utf8_bytes: Buffer.byteLength(text),
  tokens: tokenizer === null ? null : tokenizer.encode(text, [], []).length,
});
const discoveredFiles = (packet) => new Set(packet.evidence.map((item) => item.file));
function fileRecall(packet, task) {
  if (task.acceptable_evidence.length === 0 || task.codeatlas_coverage === "out_of_coverage") return null;
  const files = discoveredFiles(packet);
  return Math.max(...task.acceptable_evidence.map((set) => set.files.filter((file) => files.has(file)).length / set.files.length));
}
const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codeatlas-context-benchmark-"));
const tasks = [];
try {
  for (const repository of suite.repositories) {
    const root = path.join(temporaryRoot, repository.id);
    await cp(path.resolve(workspaceRoot, repository.fixture_root), root, { recursive: true });
    await initializeRepository(root);
    for (const task of suite.tasks.filter((item) => item.repository_id === repository.id)) {
      const full = await compileChangeContext(task.prompt, root, { budget: 100_000, format: "json" });
      const compact = compactChangeContext(full);
      assert.deepEqual(expandCompactContext(compact), full, "Compact encoding changed selected facts.");
      const variants = {};
      for (const [name, format, evidenceMode] of [
        ["json_inline", "json", "inline"],
        ["json_references", "json", "references"],
        ["compact_references", "compact", "references"],
      ]) {
        const packet = await compileChangeContext(task.prompt, root, { budget, format, evidenceMode });
        assert.deepEqual(validateChangeContextGrounding(packet), []);
        const text = serializeChangeContext(packet, format);
        assert.ok(Buffer.byteLength(text) <= budget, "Context exceeded its byte budget.");
        variants[name] = {
          ...measure(text),
          evidence_file_recall: fileRecall(packet, task),
          candidate_count: packet.change_candidates.length,
          test_count: packet.relevant_tests.length,
          path_count: packet.verified_paths.length + packet.potential_paths.length,
          gaps: [...new Set(packet.gaps.map((gap) => gap.code))],
        };
      }
      tasks.push({
        task_id: task.id, repository_id: repository.id,
        identical_facts: { json: measure(JSON.stringify(full)), compact: measure(JSON.stringify(compact)) },
        bounded_context: variants,
      });
    }
  }
} finally {
  // This is a newly created, fixed-prefix temporary directory, never a caller-supplied path.
  assert.equal(path.dirname(temporaryRoot), os.tmpdir());
  assert.ok(path.basename(temporaryRoot).startsWith("codeatlas-context-benchmark-"));
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
}
const totals = (representation) => ({
  utf8_bytes: tasks.reduce((sum, task) => sum + task.identical_facts[representation].utf8_bytes, 0),
  tokens: tokenizer === null ? null : tasks.reduce((sum, task) => sum + task.identical_facts[representation].tokens, 0),
});
const json = totals("json");
const compact = totals("compact");
const sourceHash = createHash("sha256");
async function sourceFiles(directory) {
  const entries = await readdir(path.join(workspaceRoot, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sourceFiles(`${directory}/${entry.name}`)
    : [`${directory}/${entry.name}`]));
  return files.flat();
}
const implementationFiles = [...await sourceFiles("src"), "scripts/benchmark-context.mjs", "package-lock.json"].sort();
for (const file of implementationFiles) {
  sourceHash.update(`${file}\0`).update(await readFile(path.join(workspaceRoot, file))).update("\0");
}
const report = {
  schema_version: 1, codeatlas_version: CODEATLAS_VERSION,
  source_sha256: sourceHash.digest("hex"),
  source_hash_scope: "All files under src/, benchmark script, and package-lock.json; sorted paths and contents separated by NUL.",
  suite_id: suite.id, suite_sha256: createHash("sha256").update(JSON.stringify(suite)).digest("hex"),
  suite_visibility: suite.visibility, task_count: tasks.length,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  tokenizer: tokenizer === null ? null : { id: options.get("--tokenizer-id"), encoding: encodingName },
  interpretation: "Development-fixture context measurements. Identical-facts compression is lossless. Reference-mode recall measures discovery of evidence files, not source understanding, task success, provider billing, or superiority over another tool.",
  identical_facts: {
    json, compact,
    byte_reduction_fraction: 1 - compact.utf8_bytes / json.utf8_bytes,
    token_reduction_fraction: tokenizer === null ? null : 1 - compact.tokens / json.tokens,
  },
  bounded_context: {
    byte_budget: budget,
    variants: Object.fromEntries(["json_inline", "json_references", "compact_references"].map((name) => [name, {
      median_evidence_file_recall: median(tasks.flatMap((task) => task.bounded_context[name].evidence_file_recall ?? [])),
      mean_evidence_file_recall: (() => {
        const recalls = tasks.flatMap((task) => task.bounded_context[name].evidence_file_recall ?? []);
        return recalls.length === 0 ? null : recalls.reduce((sum, value) => sum + value, 0) / recalls.length;
      })(),
      evidence_tasks_measured: tasks.filter((task) => task.bounded_context[name].evidence_file_recall !== null).length,
      evidence_tasks_complete: tasks.filter((task) => task.bounded_context[name].evidence_file_recall === 1).length,
      candidates: tasks.reduce((sum, task) => sum + task.bounded_context[name].candidate_count, 0),
      tests: tasks.reduce((sum, task) => sum + task.bounded_context[name].test_count, 0),
      paths: tasks.reduce((sum, task) => sum + task.bounded_context[name].path_count, 0),
      median_tokens: tokenizer === null ? null : median(tasks.map((task) => task.bounded_context[name].tokens)),
      median_utf8_bytes: median(tasks.map((task) => task.bounded_context[name].utf8_bytes)),
    }])),
  },
  tasks,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (options.has("--output")) {
  const destination = path.resolve(options.get("--output"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, serialized, "utf8");
  process.stdout.write(`${JSON.stringify({ output: destination, identical_facts: report.identical_facts, bounded_context: report.bounded_context }, null, 2)}\n`);
} else process.stdout.write(serialized);
