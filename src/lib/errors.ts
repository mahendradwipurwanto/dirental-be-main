export type ErrorIssue = { path: string; message: string };

/**
 * Application error carried through Express to the terminal error handler,
 * which serialises it as `{ error: { code, message, issues? } }`.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ErrorIssue[] | undefined;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, issues?: ErrorIssue[]) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.expose = status < 500;
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', issues?: ErrorIssue[]) =>
  new AppError(400, code, message, issues);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'Forbidden', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message);
export const unprocessable = (message: string, issues?: ErrorIssue[], code = 'VALIDATION_ERROR') =>
  new AppError(422, code, message, issues);
export const tooMany = (message = 'Too many requests', code = 'RATE_LIMITED') => new AppError(429, code, message);
export const internal = (message = 'Internal server error') => new AppError(500, 'INTERNAL', message);
