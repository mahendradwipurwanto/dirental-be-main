import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
};

/**
 * Terminal error handler. Vercel's Express docs warn that unhandled errors let Express render its own
 * 500 page and can leave the function instance in a bad state, so every error ends here as JSON.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const log = req.log ?? logger;

  if (err instanceof AppError) {
    if (err.status >= 500) log.error({ err }, err.message);
    res.status(err.status).json({
      error: { code: err.code, message: err.expose ? err.message : 'Internal server error', issues: err.issues },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  // body-parser errors (malformed JSON, payload too large)
  const anyErr = err as { type?: string; status?: number; message?: string };
  if (anyErr?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
    return;
  }
  if (anyErr?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
    return;
  }

  log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};
