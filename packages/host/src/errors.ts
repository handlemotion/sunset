import { isGitError } from "@sunset/git";

export class HostError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HostError";
    this.code = code;
  }
}

export function isHostError(value: unknown): value is HostError {
  return value instanceof HostError;
}

export type SunsetBoundaryError = Error & {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export function isSunsetBoundaryError(
  value: unknown,
): value is SunsetBoundaryError {
  return isHostError(value) || isGitError(value);
}

export function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
}
