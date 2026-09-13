import type { RequestHandler } from 'express';
import { nanoid } from 'nanoid';
import { logger } from '../lib/logger.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      log: typeof logger;
    }
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = (req.header('x-vercel-id') ?? req.header('x-request-id') ?? nanoid(12)).slice(0, 64);
  req.id = id;
  req.log = logger.child({ reqId: id });
  res.setHeader('x-request-id', id);

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    req.log.info({ method: req.method, path: req.originalUrl, status: res.statusCode, ms: Math.round(ms) }, 'request');
  });
  next();
};
