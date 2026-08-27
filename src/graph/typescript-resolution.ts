import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript-compiler";
import type { UnresolvedReference } from "../parser/parser.js";
import { isPathInside, toPosixPath } from "../core/paths.js";

interface PackageManifest {
  name?: unknown;
  main?: unknown;
  module?: unknown;
  types?: unknown;
  exports?: unknown;
}

export interface SemanticTarget {
  filePath: string;
  name: string;
  line: number;
}

interface ProjectContext {
  configPath: string | null;
  options: ts.CompilerOptions;
  rootNames: string[];
  projectReferences?: readonly ts.ProjectReference[];
  program?: ts.Program;
}

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function json(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function exportTargets(value: unknown, subpath: string): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const direct = record[subpath];
  if (direct !== undefined) return exportTargets(direct, subpath);
  for (const key of ["types", "import", "require", "default"]) {
    if (record[key] !== undefined) return exportTargets(record[key], subpath);
  }
  return [];
}

/** Project-aware resolver backed by TypeScript's own config and module-resolution APIs. */
export class TypeScriptProjectResolver {
  readonly #repositoryRoot: string;
  readonly #indexedPaths: ReadonlySet<string>;
  readonly #projectBySource = new Map<string, ProjectContext>();
  readonly #projectByConfig = new Map<string, ProjectContext>();
  readonly #moduleCache = new Map<string, string[]>();
  readonly #workspacePackages = new Map<string, { directory: string; manifest: PackageManifest }>();

  constructor(repositoryRoot: string, indexedPaths: ReadonlySet<string>) {
    this.#repositoryRoot = path.resolve(repositoryRoot);
    this.#indexedPaths = indexedPaths;
    for (const relativePath of indexedPaths) {
      if (path.posix.basename(relativePath) !== "package.json") continue;
      const manifest = json(path.join(this.#repositoryRoot, ...relativePath.split("/")));
      if (typeof manifest !== "object" || manifest === null) continue;
      const typed = manifest as PackageManifest;
      if (typeof typed.name !== "string") continue;
      this.#workspacePackages.set(typed.name, {
        directory: path.posix.dirname(relativePath),
        manifest: typed,
      });
    }
  }

  #relativeIndexedPath(absolutePath: string): string | null {
    let resolved = path.resolve(absolutePath);
    try {
      if (existsSync(resolved)) resolved = realpathSync.native(resolved);
    } catch {
      // Broken symlinks and partial installs are ordinary indexing conditions.
    }
    if (!isPathInside(this.#repositoryRoot, resolved)) return null;
    const relative = toPosixPath(path.relative(this.#repositoryRoot, resolved));
    if (this.#indexedPaths.has(relative)) return relative;
    const extension = path.posix.extname(relative);
    const withoutExtension = extension === "" ? relative : relative.slice(0, -extension.length);
    for (const candidate of [
      ...JS_EXTENSIONS.map((suffix) => `${withoutExtension}${suffix}`),
      ...JS_EXTENSIONS.map((suffix) => path.posix.join(relative, `index${suffix}`)),
    ]) {
      if (this.#indexedPaths.has(candidate)) return candidate;
    }
    return null;
  }

  #loadProject(sourceFile: string): ProjectContext {
    const cached = this.#projectBySource.get(sourceFile);
    if (cached !== undefined) return cached;
    const absoluteSource = path.join(this.#repositoryRoot, ...sourceFile.split("/"));
    const sourceDirectory = path.dirname(absoluteSource);
    const configPath = ts.findConfigFile(sourceDirectory, ts.sys.fileExists, "tsconfig.json") ??
      ts.findConfigFile(sourceDirectory, ts.sys.fileExists, "jsconfig.json") ?? null;
    if (configPath !== null) {
      const existing = this.#projectByConfig.get(configPath);
      if (existing !== undefined) {
        this.#projectBySource.set(sourceFile, existing);
        return existing;
      }
      const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
      if (loaded.error === undefined) {
        const parsed = ts.parseJsonConfigFileContent(
          loaded.config,
          ts.sys,
          path.dirname(configPath),
          undefined,
          configPath,
        );
        const project: ProjectContext = {
          configPath,
          options: parsed.options,
          rootNames: parsed.fileNames,
          ...(parsed.projectReferences === undefined
            ? {}
            : { projectReferences: parsed.projectReferences }),
        };
        this.#projectByConfig.set(configPath, project);
        this.#projectBySource.set(sourceFile, project);
        return project;
      }
    }
    const project: ProjectContext = {
      configPath: null,
      options: {
        allowJs: true,
        resolveJsonModule: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
      rootNames: [absoluteSource],
    };
    this.#projectBySource.set(sourceFile, project);
    return project;
  }

  #workspaceCandidates(specifier: string): string[] {
    const packageName = [...this.#workspacePackages.keys()]
      .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (packageName === undefined) return [];
    const entry = this.#workspacePackages.get(packageName)!;
    const suffix = specifier.slice(packageName.length).replace(/^\//u, "");
    const subpath = suffix === "" ? "." : `./${suffix}`;
    const manifestTargets = exportTargets(entry.manifest.exports, subpath);
    const legacyTargets = suffix === ""
      ? [entry.manifest.types, entry.manifest.module, entry.manifest.main]
          .filter((value): value is string => typeof value === "string")
      : [suffix];
    return [...manifestTargets, ...legacyTargets, `src/${suffix || "index"}`, suffix || "index"]
      .map((target) => target.replace(/^\.\//u, ""))
      .flatMap((target) => {
        const base = path.posix.normalize(path.posix.join(entry.directory, target));
        const extension = path.posix.extname(base);
        return extension === ""
          ? [base, ...JS_EXTENSIONS.map((value) => `${base}${value}`),
              ...JS_EXTENSIONS.map((value) => path.posix.join(base, `index${value}`))]
          : [base];
      })
      .filter((candidate) => this.#indexedPaths.has(candidate));
  }

  resolveModule(specifier: string, sourceFile: string): string[] {
    const key = `${sourceFile}\0${specifier}`;
    const cached = this.#moduleCache.get(key);
    if (cached !== undefined) return cached;
    if (!/\.[cm]?[jt]sx?$/u.test(sourceFile)) return [];
    const project = this.#loadProject(sourceFile);
    const absoluteSource = path.join(this.#repositoryRoot, ...sourceFile.split("/"));
    const resolved = ts.resolveModuleName(specifier, absoluteSource, project.options, ts.sys)
      .resolvedModule?.resolvedFileName;
    const compilerCandidate = resolved === undefined ? null : this.#relativeIndexedPath(resolved);
    const candidates = [...new Set([
      ...(compilerCandidate === null ? [] : [compilerCandidate]),
      ...this.#workspaceCandidates(specifier),
    ])].sort((left, right) => left.localeCompare(right));
    this.#moduleCache.set(key, candidates);
    return candidates;
  }

  resolveCall(reference: UnresolvedReference): SemanticTarget | null {
    if (reference.kind !== "call" || !/\.[cm]?[jt]sx?$/u.test(reference.evidence.file)) {
      return null;
    }
    try {
      const project = this.#loadProject(reference.evidence.file);
      project.program ??= ts.createProgram({
        rootNames: project.rootNames,
        options: project.options,
        ...(project.projectReferences === undefined
          ? {}
          : { projectReferences: project.projectReferences }),
      });
      const absoluteSource = path.join(
        this.#repositoryRoot,
        ...reference.evidence.file.split("/"),
      );
      const source = project.program.getSourceFile(absoluteSource) ??
        project.program.getSourceFiles().find((file) =>
          this.#relativeIndexedPath(file.fileName) === reference.evidence.file,
        );
      if (source === undefined) return null;
      const position = source.getPositionOfLineAndCharacter(
        Math.max(0, reference.evidence.line - 1),
        Math.max(0, reference.evidence.column),
      );
      const calls: Array<ts.CallExpression | ts.NewExpression> = [];
      const lastName = reference.name.split(".").at(-1) ?? reference.name;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const startLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const expression = node.expression.getText(source);
          if (
            startLine === reference.evidence.line &&
            (expression === reference.name || expression.endsWith(`.${lastName}`))
          ) {
            calls.push(node);
          }
        }
        node.forEachChild(visit);
      };
      visit(source);
      const current = calls.find((call) => position >= call.getStart(source) && position <= call.getEnd()) ??
        calls[0];
      if (current === undefined) return null;
      const declaration = project.program.getTypeChecker().getResolvedSignature(current)?.declaration;
      if (declaration === undefined) return null;
      const filePath = this.#relativeIndexedPath(declaration.getSourceFile().fileName);
      if (filePath === null) return null;
      const name = ("name" in declaration ? declaration.name?.getText(declaration.getSourceFile()) : null) ??
        reference.name.split(".").at(-1) ?? reference.name;
      const line = declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
      return { filePath, name, line };
    } catch {
      return null;
    }
  }
}
