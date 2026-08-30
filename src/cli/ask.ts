import { answerFromAtlas } from "../ai/answering.js";
import { loadCurrentAtlas } from "./v2-query.js";

export async function askRepository(question: string, startPath = process.cwd()) {
  return answerFromAtlas(await loadCurrentAtlas(startPath), question);
}

export function formatAnswer(result: Awaited<ReturnType<typeof askRepository>>): string {
  return [
    result.answer,
    "",
    "Evidence:",
    ...result.evidence.map((item) =>
      `  ${item.file}:${item.start_line}-${item.end_line} (${item.id})`,
    ),
  ].join("\n");
}
