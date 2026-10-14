import type { ErrorCode } from "./domain/models";

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  API_DOWN: 503,
};

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

/** Galat dari Commute Data API (jaringan, timeout, 5xx). Dipetakan ke API_DOWN bila tidak ada cache. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}
