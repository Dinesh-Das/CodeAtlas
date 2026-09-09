import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { evaluationSuiteSchema, EVALUATION_HARNESS_VERSION } from "../dist/evaluation/models.js";

const execFile = promisify(execFileCallback);

function optionsFrom(arguments_) {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (!name?.startsWith("--")) throw new Error(`Unexpected argument ${name}.`);
    if (name === "--dry-run" || name === "--keep-workspaces") {
      options.set(name, true);
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    options.set(name, value);
    index += 1;
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (value === undefined) throw new Error(`${name} is required.`);
  return String(value);
}

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function outputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "answer_text", "abstained", "evidence_files", "concepts", "relationship_types",
      "starting_files",
    ],
    properties: {
      answer_text: { type: "string" },
      abstained: { type: "boolean" },
      evidence_files: { type: "array", items: { type: "string" } },
      concepts: { type: "array", items: { type: "string" } },
      relationship_types: { type: "array", items: { type: "string" } },
      starting_files: { type: "array", items: { type: "string" } },
    },
  };
}

function normalizeFile(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function evidenceRecall(task, files) {
  if (task.answerability === "unanswerable") return files.length === 0 ? 1 : 0;
  const actual = new Set(files.map(normalizeFile));
  return Math.max(...task.acceptable_evidence.map((set) =>
    set.files.filter((file) => actual.has(normalizeFile(file))).length / set.files.length
  ));
}

function expectationPassed(task, answer) {
  const expectations = task.expectations;
  if (expectations === undefined) return true;
  const text = `${answer.answer_text}\n${answer.concepts.join("\n")}`.toLowerCase();
  const relationships = new Set(answer.relationship_types.map((item) => item.toUpperCase()));
  const starts = new Set(answer.starting_files.map(normalizeFile));
  return expectations.required_concepts.every((concept) => text.includes(concept.toLowerCase())) &&
    expectations.required_relationship_types.every((type) => relationships.has(type.toUpperCase())) &&
    (expectations.allowed_starting_files.length === 0 ||
      expectations.allowed_starting_files.some((file) => starts.has(normalizeFile(file)))) &&
    expectations.forbidden_distractors.every((value) => !text.includes(value.toLowerCase()));
}

function scoredSuccess(task, answer) {
  if (task.answerability === "unanswerable") return answer.abstained && answer.evidence_files.length === 0;
  return !answer.abstained && evidenceRecall(task, answer.evidence_files) === 1 &&
    expectationPassed(task, answer);
}

function visit(value, callback) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
  } else if (typeof value === "object" && value !== null) {
    callback(value);
    for (const child of Object.values(value)) visit(child, callback);
  }
}

function eventMetrics(stdout) {
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    visit(event, (value) => {
      const input = value.input_tokens ?? value.inputTokens;
      const output = value.output_tokens ?? value.outputTokens;
      if (typeof input === "number") inputTokens = Math.max(inputTokens, input);
      if (typeof output === "number") outputTokens = Math.max(outputTokens, output);
      const type = value.type;
      if (typeof type === "string" && /(?:command_execution|mcp_tool_call|tool_call)$/u.test(type)) {
        toolCalls += 1;
      }
    });
  }
  return { inputTokens, outputTokens, toolCalls };
}

async function createWorkspace(fixtureRoot, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `codeatlas-eval-${safeId(label)}-`));
  await cp(fixtureRoot, root, { recursive: true });
  await execFile("git", ["init", "-b", "main"], { cwd: root, windowsHide: true });
  await execFile("git", ["config", "user.name", "CodeAtlas Evaluation"], { cwd: root, windowsHide: true });
  await execFile("git", ["config", "user.email", "evaluation@example.invalid"], { cwd: root, windowsHide: true });
  await execFile("git", ["add", "."], { cwd: root, windowsHide: true });
  await execFile("git", ["commit", "-m", "pinned evaluation fixture"], { cwd: root, windowsHide: true });
  return root;
}

function promptFor(task, variant, cliPath) {
  const variantInstructions = variant === "codeatlas"
    ? [
        "Start with this repository-local CodeAtlas command and use its evidence before opening source files:",
        `node ${JSON.stringify(cliPath)} context ${JSON.stringify(task.prompt)} . --budget ${task.context_token_budget} --format json`,
        "You may use other read-only CodeAtlas commands when the first packet is insufficient.",
      ].join("\n")
    : "Do not run CodeAtlas. Use ordinary repository search and source-reading commands.";
  return [
    "Work read-only. Answer the repository question with source evidence.",
    variantInstructions,
    `Question: ${task.prompt}`,
    `Expected behavior for grading: ${task.expected_behavior}`,
    "Return only the requested structured result. List repository-relative evidence files, the files you inspected first, important concepts stated in the answer, and canonical relationship types you used. Abstain when the repository cannot support the answer.",
  ].join("\n\n");
}

async function initializeCodeAtlas(cliPath, workspace) {
  await execFile(process.execPath, [cliPath, "init", workspace], {
    cwd: workspace,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  });
}

async function runCodex({ workspace, prompt, model, schemaPath, answerPath }) {
  const startedAt = performance.now();
  const executable = process.platform === "win32" ? "codex.cmd" : "codex";
  const { stdout } = await execFile(executable, [
    "exec",
    "--ephemeral",
    "--json",
    "--color", "never",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--model", model,
    "--output-schema", schemaPath,
    "--output-last-message", answerPath,
    "--cd", workspace,
    prompt,
  ], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
  return { stdout, durationMs: performance.now() - startedAt };
}

const options = optionsFrom(process.argv.slice(2));
const workspaceRoot = process.cwd();
const suitePath = path.resolve(String(options.get("--suite") ?? "evals/development.json"));
const suite = evaluationSuiteSchema.parse(JSON.parse(await readFile(suitePath, "utf8")));
const provider = String(options.get("--provider") ?? "codex");
if (provider !== "codex") throw new Error(`Unsupported provider ${provider}; expected codex.`);
const model = required(options, "--model");
const modelVersion = required(options, "--model-version");
const repeats = Number(options.get("--repeats") ?? suite.minimum_repeats);
if (!Number.isInteger(repeats) || repeats < suite.minimum_repeats) {
  throw new Error(`--repeats must be at least ${suite.minimum_repeats}.`);
}
const outputDirectory = path.resolve(String(options.get("--output-dir") ?? "evals/runs/latest"));
const taskFilter = options.get("--task");
const tasks = taskFilter === undefined
  ? suite.tasks
  : suite.tasks.filter((task) => task.id === taskFilter);
if (tasks.length === 0) throw new Error(`No task matched ${taskFilter}.`);
const repositories = new Map(suite.repositories.map((repository) => [repository.id, repository]));
const cliPath = path.resolve("dist/cli/index.js");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codeatlas-provider-eval-"));
const schemaPath = path.join(temporaryRoot, "answer.schema.json");
await writeFile(schemaPath, `${JSON.stringify(outputSchema(), null, 2)}\n`, "utf8");

const expectedRuns = tasks.length * repeats * 2;
if (options.has("--dry-run")) {
  console.log(JSON.stringify({
    valid: true,
    provider,
    model,
    model_version: modelVersion,
    tasks: tasks.length,
    repeats,
    expected_observations: expectedRuns,
    variants: ["native", "codeatlas"],
  }, null, 2));
  await rm(temporaryRoot, { recursive: true, force: true });
  process.exit(0);
}

await mkdir(outputDirectory, { recursive: true });
const observations = [];
let completed = 0;
try {
  for (const task of tasks) {
    const repository = repositories.get(task.repository_id);
    if (repository === undefined) throw new Error(`Unknown repository ${task.repository_id}.`);
    const fixtureRoot = path.resolve(workspaceRoot, ...repository.fixture_root.split("/"));
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const variant of ["native", "codeatlas"]) {
        const label = `${task.id}-${variant}-${repeat}`;
        const workspace = await createWorkspace(fixtureRoot, label);
        const answerPath = path.join(temporaryRoot, `${safeId(label)}.json`);
        try {
          if (variant === "codeatlas") await initializeCodeAtlas(cliPath, workspace);
          const run = await runCodex({
            workspace,
            prompt: promptFor(task, variant, cliPath),
            model,
            schemaPath,
            answerPath,
          });
          const answer = JSON.parse(await readFile(answerPath, "utf8"));
          const usage = eventMetrics(run.stdout);
          observations.push({
            schema_version: 1,
            task_id: task.id,
            variant,
            repeat,
            success: scoredSuccess(task, answer),
            abstained: answer.abstained,
            evidence_files: answer.evidence_files.map(normalizeFile),
            answer_text: answer.answer_text,
            concepts: answer.concepts,
            relationship_types: answer.relationship_types,
            starting_files: answer.starting_files.map(normalizeFile),
            metrics: {
              context_tokens: usage.inputTokens,
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              duration_ms: Number(run.durationMs.toFixed(3)),
              tool_calls: usage.toolCalls,
              cost_usd: null,
            },
            extraction: null,
            explanation: null,
            patch: null,
            knowledge_transfer: null,
          });
          completed += 1;
          console.error(`[${completed}/${expectedRuns}] ${label}`);
        } finally {
          if (!options.has("--keep-workspaces")) {
            await rm(workspace, { recursive: true, force: true, maxRetries: 5 });
          }
        }
      }
    }
  }
} finally {
  if (!options.has("--keep-workspaces")) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

const runId = `${safeId(suite.id)}-${new Date().toISOString().replace(/[:.]/gu, "-").toLowerCase()}`;
const run = {
  schema_version: 1,
  evaluator_version: EVALUATION_HARNESS_VERSION,
  id: runId,
  suite_id: suite.id,
  created_at: new Date().toISOString(),
  model: { provider: "openai-codex", id: model, version: modelVersion },
  harness: { id: "codeatlas-provider-runner", version: "1.0.0" },
  cache_state: "cold",
  repeats,
  variants: ["native", "codeatlas"],
};
const runPath = path.join(outputDirectory, "run.json");
const observationsPath = path.join(outputDirectory, "observations.jsonl");
await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
await writeFile(observationsPath, `${observations.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({ run: runPath, observations: observationsPath, count: observations.length }, null, 2));
