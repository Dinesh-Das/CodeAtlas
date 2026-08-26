export class CodeAtlasError extends Error {
  readonly exitCode: number;

  constructor(message: string, options: { cause?: unknown; exitCode?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodeAtlasError";
    this.exitCode = options.exitCode ?? 1;
  }
}
