export class GitError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    message: string,
    code: string,
    options?: {
      cause?: unknown;
      details?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message, options);
    this.name = "GitError";
    this.code = code;
    this.details = options?.details;
  }
}

export function isGitError(value: unknown): value is GitError {
  return value instanceof GitError;
}
