import { CodeAtlasError } from "../core/errors.js";
import { compileChangeContext } from "../context/planner.js";
import { serializeChangeContext, type ChangeContextFormat } from "../context/packet.js";

export async function createChangeContext(
  task: string | undefined,
  startPath = process.cwd(),
  options: { budget: number; format: ChangeContextFormat; gitBase?: string },
): Promise<string> {
  if (task === undefined && options.gitBase === undefined) {
    throw new CodeAtlasError("A task or --diff base is required.", {
      code: "invalid_argument",
      recoverable: true,
      nextActions: ["Describe the intended change or pass --diff <base>."],
    });
  }
  const effectiveTask = task ?? `Prepare change context for the working-tree difference from ${options.gitBase}.`;
  const packet = await compileChangeContext(effectiveTask, startPath, {
    budget: options.budget,
    format: options.format,
    ...(options.gitBase === undefined ? {} : { gitBase: options.gitBase }),
  });
  return serializeChangeContext(packet, options.format);
}
