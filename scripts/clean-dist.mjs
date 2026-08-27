import { rm } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve("dist");
if (path.basename(outputDirectory) !== "dist") {
  throw new Error(`Refusing to remove unexpected build directory: ${outputDirectory}`);
}

await rm(outputDirectory, { recursive: true, force: true });
