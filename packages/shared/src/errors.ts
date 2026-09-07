/**
 * Error codes shared by the Local API, CLI and MCP surfaces.
 * Every error that leaves the runtime is one of these.
 */
export const ErrorCodes = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  INVALID_STATE: "INVALID_STATE",
  IDEMPOTENCY_MISMATCH: "IDEMPOTENCY_MISMATCH",
  UNAUTHORIZED: "UNAUTHORIZED",
  UNAVAILABLE: "UNAVAILABLE",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const errorHttpStatus: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  INVALID_STATE: 409,
  IDEMPOTENCY_MISMATCH: 422,
  UNAUTHORIZED: 401,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export class TodoCueError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "TodoCueError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return errorHttpStatus[this.code];
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { error: { code: this.code, message: this.message } };
    if (this.details !== undefined) body.error.details = this.details;
    return body;
  }

  static notFound(what: string, id: string): TodoCueError {
    return new TodoCueError(ErrorCodes.NOT_FOUND, `${what} ${id} not found`, { id });
  }

  static conflict(id: string, expected: number, actual: number): TodoCueError {
    return new TodoCueError(
      ErrorCodes.VERSION_CONFLICT,
      `version conflict for ${id}: expected ${expected}, current ${actual}`,
      { id, expectedVersion: expected, currentVersion: actual },
    );
  }

  static invalidState(message: string, details?: unknown): TodoCueError {
    return new TodoCueError(ErrorCodes.INVALID_STATE, message, details);
  }

  static validation(message: string, details?: unknown): TodoCueError {
    return new TodoCueError(ErrorCodes.VALIDATION_ERROR, message, details);
  }
}

export function isTodoCueError(e: unknown): e is TodoCueError {
  return e instanceof TodoCueError || (typeof e === "object" && e !== null && (e as { name?: string }).name === "TodoCueError");
}
