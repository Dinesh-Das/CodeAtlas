import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function javascriptEntry(file) {
  const resolved = path.resolve(file);
  if (!/\.(?:cjs|mjs|js)$/iu.test(resolved) || !existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error("Codex JavaScript entry point must be an existing .js, .mjs, or .cjs file.");
  }
  return { command: process.execPath, prefix: [resolved] };
}

export function resolveCodexLaunch({ platform = process.platform, environment = process.env, cliJs } = {}) {
  const override = cliJs ?? environment.CODEX_CLI_JS;
  if (override !== undefined) return javascriptEntry(override);
  if (platform !== "win32") return { command: "codex", prefix: [] };

  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH");
  const directories = (environment[pathKey] ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
  for (const directory of directories) {
    const native = path.join(directory, "codex.exe");
    if (existsSync(native) && statSync(native).isFile()) return { command: native, prefix: [] };
    const manifests = [
      path.join(directory, "node_modules", "@openai", "codex", "package.json"),
      ...(path.basename(directory) === ".bin"
        ? [path.resolve(directory, "..", "@openai", "codex", "package.json")]
        : []),
    ];
    for (const manifest of manifests) {
      if (!existsSync(manifest)) continue;
      const metadata = JSON.parse(readFileSync(manifest, "utf8"));
      if (metadata.name !== "@openai/codex" || typeof metadata.bin?.codex !== "string") continue;
      const root = path.dirname(manifest);
      const entry = path.resolve(root, metadata.bin.codex);
      const relative = path.relative(root, entry);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Codex JavaScript entry point escapes its installation directory.");
      }
      return javascriptEntry(entry);
    }
  }
  throw new Error("Codex installation was not found. Supply --codex-cli-js with its JavaScript entry point.");
}

export async function runCodex({ workspace, prompt, model, schemaPath, answerPath, cliJs }) {
  const launch = resolveCodexLaunch({ cliJs });
  const { stdout } = await execFile(launch.command, [...launch.prefix,
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
  return { stdout };
}
