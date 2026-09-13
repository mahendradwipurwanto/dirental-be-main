import type { RequestHandler } from 'express';
import type { ZodType, z } from 'zod';
import { unprocessable } from '../lib/errors.js';

type Schemas = {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
};

type Validated<S extends Schemas> = {
  body: S['body'] extends ZodType ? z.output<S['body']> : undefined;
  query: S['query'] extends ZodType ? z.output<S['query']> : undefined;
  params: S['params'] extends ZodType ? z.output<S['params']> : undefined;
};

declare global {
  namespace Express {
    interface Request {
      /** Typed per-route via `TypedRequest` in lib/route.ts; `unknown` here so intersections stay sound. */
      valid: unknown;
    }
  }
}

/**
 * Validates request parts with zod and attaches the parsed values to `req.valid`.
 * Express 5 makes `req.query` a getter, so we never mutate it; typed access goes through `req.valid`.
 */
export function validate<S extends Schemas>(schemas: S): RequestHandler {
  return (req, _res, next) => {
    const out: Record<string, unknown> = {};
    const issues: { path: string; message: string }[] = [];

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        out[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ path: [part, ...issue.path].join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      next(unprocessable('Validation failed', issues));
      return;
    }
    req.valid = out;
    next();
  };
}

/** Typed accessor for handlers: `const { body } = valid<typeof schemas>(req)`. */
export function valid<S extends Schemas>(req: { valid: unknown }): Validated<S> {
  return req.valid as Validated<S>;
}
