import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateRun,
  validatePinnedFixtures,
} from "../dist/evaluation/runner.js";
import { evaluationSuiteSchema } from "../dist/evaluation/models.js";

function optionsFrom(arguments_) {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (!name?.startsWith("--")) throw new Error(`Unexpected argument ${name}.`);
    if (name === "--verify-fixtures" || name === "--require-gate") {
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
function parseJsonLines(text, source) {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    const value = JSON.parse(trimmed);
    if (!Array.isArray(value)) throw new Error(`${source} must contain an array or JSON Lines.`);
    return value;
  }
  return trimmed.split(/\r?\n/u).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${source}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

const options = optionsFrom(process.argv.slice(2));
const workspaceRoot = process.cwd();
const suitePath = path.resolve(String(options.get("--suite") ?? "evals/development.json"));
const suite = JSON.parse(await readFile(suitePath, "utf8"));
const suiteResult = evaluationSuiteSchema.safeParse(suite);
const fixtureErrors = options.has("--verify-fixtures")
  ? await validatePinnedFixtures(suite, workspaceRoot)
  : [];
const runPath = options.get("--run");
const observationsPath = options.get("--observations");

if ((runPath === undefined) !== (observationsPath === undefined)) {
  throw new Error("--run and --observations must be supplied together.");
}

if (runPath === undefined) {
  const categories = suiteResult.success
    ? Object.fromEntries([...new Set(suiteResult.data.tasks.map((task) => task.category))]
      .sort()
      .map((category) => [category, suiteResult.data.tasks.filter((task) => task.category === category).length]))
    : {};
  const summary = {
    valid: suiteResult.success && fixtureErrors.length === 0,
    suite_id: suiteResult.success ? suiteResult.data.id : null,
    repositories: suiteResult.success ? suiteResult.data.repositories.length : 0,
    tasks: suiteResult.success ? suiteResult.data.tasks.length : 0,
    minimum_repeats: suiteResult.success ? suiteResult.data.minimum_repeats : 0,
    required_observations: suiteResult.success
      ? suiteResult.data.tasks.length * suiteResult.data.minimum_repeats * 2
      : 0,
    categories,
    errors: [
      ...(suiteResult.success ? [] : suiteResult.error.issues.map((issue) =>
        `${issue.path.join(".") || "suite"}: ${issue.message}`
      )),
      ...fixtureErrors,
    ],
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.valid) process.exitCode = 1;
} else {
  const run = JSON.parse(await readFile(path.resolve(String(runPath)), "utf8"));
  const observations = parseJsonLines(
    await readFile(path.resolve(String(observationsPath)), "utf8"),
    String(observationsPath),
  );
  const report = evaluateRun(suite, run, observations);
  report.errors.unshift(...fixtureErrors);
  if (fixtureErrors.length > 0) {
    report.complete = false;
    report.launch_gate.status = "incomplete";
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = options.get("--output");
  if (outputPath === undefined) console.log(serialized.trimEnd());
  else {
    const absoluteOutput = path.resolve(String(outputPath));
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, serialized, "utf8");
    console.log(`Wrote ${absoluteOutput}`);
  }
  if (!report.complete || (options.has("--require-gate") && report.launch_gate.status !== "passed")) {
    process.exitCode = 1;
  }
}
