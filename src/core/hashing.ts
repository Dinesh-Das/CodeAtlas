import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
}

export function hashSortedEntries(entries: readonly string[]): string {
  return sha256([...entries].sort((left, right) => left.localeCompare(right)).join("\n"));
}
