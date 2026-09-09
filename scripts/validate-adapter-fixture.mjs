import { readFile } from "node:fs/promises";

const [expectedPath, actualPath] = process.argv.slice(2);
if (expectedPath === undefined || actualPath === undefined) {
  throw new Error("Usage: node scripts/validate-adapter-fixture.mjs EXPECTED.json ACTUAL.json");
}

const expected = JSON.parse(await readFile(expectedPath, "utf8"));
const actual = JSON.parse(await readFile(actualPath, "utf8"));
const edgeKey = (edge) => `${edge.source}\0${edge.type}\0${edge.target}`;
const expectedEdges = new Set(expected.edges.map(edgeKey));
const actualEdges = new Set(actual.edges.map(edgeKey));
const truePositives = [...actualEdges].filter((edge) => expectedEdges.has(edge)).length;
const precision = actualEdges.size === 0 ? (expectedEdges.size === 0 ? 1 : 0) : truePositives / actualEdges.size;
const recall = expectedEdges.size === 0 ? 1 : truePositives / expectedEdges.size;
const minimumPrecision = expected.gates?.minimumPrecision ?? 0.95;
const minimumRecall = expected.gates?.minimumRecall ?? 0.90;
const report = {
  expected: expectedEdges.size,
  actual: actualEdges.size,
  truePositives,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  minimumPrecision,
  minimumRecall,
  passed: precision >= minimumPrecision && recall >= minimumRecall,
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
