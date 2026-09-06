export class CodeAtlasError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly recoverable: boolean;
  readonly nextActions: string[];
  readonly details: Record<string, unknown>;

  constructor(message: string, options: {
    cause?: unknown;
    exitCode?: number;
    code?: string;
    recoverable?: boolean;
    nextActions?: string[];
    details?: Record<string, unknown>;
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodeAtlasError";
    this.exitCode = options.exitCode ?? 1;
    this.code = options.code ?? "codeatlas_error";
    this.recoverable = options.recoverable ?? false;
    this.nextActions = options.nextActions ?? [];
    this.details = options.details ?? {};
  }
}
