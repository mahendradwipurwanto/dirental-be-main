import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { ZodType, z } from 'zod';
import { errorResponseSchema, registry } from './openapi.js';
import { validate } from '../middleware/validate.js';
import { logger } from './logger.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type RouteAuth = 'cookie' | 'none' | 'cron' | 'webkey';

type Out<S> = S extends ZodType ? z.output<S> : undefined;
type In<S> = S extends ZodType ? z.input<S> : void;

export type TypedRequest<P, Q, B> = Request & { valid: { params: Out<P>; query: Out<Q>; body: Out<B> } };

export type RouteDef<
  P extends ZodType | undefined,
  Q extends ZodType | undefined,
  B extends ZodType | undefined,
  R extends ZodType | undefined,
> = {
  method: Method;
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag?: string;
  auth?: RouteAuth;
  params?: P;
  query?: Q;
  body?: B;
  response?: R;
  /** Success status, default 200 (201 for creates, 204 for no content). */
  status?: number;
  middlewares?: RequestHandler[];
};

const errorStatuses: Record<number, string> = {
  400: 'Bad request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  422: 'Validation failed',
  429: 'Rate limited',
};

const securityFor = (auth: RouteAuth) => {
  switch (auth) {
    case 'cookie':
      return [{ cookieAuth: [] }];
    case 'webkey':
      return [{ webKey: [] }];
    case 'cron':
      return [{ cronSecret: [] }];
    default:
      return undefined;
  }
};

/** `/tenants/:slug/listings/:id` → `/tenants/{slug}/listings/{id}` */
const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/**
 * Creates an Express router whose routes are also registered in the OpenAPI registry, so the
 * spec that the frontends generate types from can never drift from what the server validates.
 * The handler's return value is parsed through `response` (which also strips unknown keys, so
 * a row with sensitive columns can never leak) and sent as JSON.
 */
export function createRouter(basePath: string, defaults: { tag: string; auth: RouteAuth; middlewares?: RequestHandler[] }) {
  const router = Router();

  function route<
    P extends ZodType | undefined = undefined,
    Q extends ZodType | undefined = undefined,
    B extends ZodType | undefined = undefined,
    R extends ZodType | undefined = undefined,
  >(def: RouteDef<P, Q, B, R>, handler: (req: TypedRequest<P, Q, B>, res: Response) => Promise<In<R>> | In<R>) {
    const status = def.status ?? 200;
    const auth = def.auth ?? defaults.auth;

    registry.registerPath({
      method: def.method,
      path: toOpenApiPath(basePath + def.path),
      operationId: def.operationId,
      summary: def.summary,
      description: def.description,
      tags: [def.tag ?? defaults.tag],
      security: securityFor(auth),
      request: {
        params: def.params as never,
        query: def.query as never,
        body: def.body ? { content: { 'application/json': { schema: def.body } } } : undefined,
      },
      responses: {
        [status]: def.response
          ? { description: 'Success', content: { 'application/json': { schema: def.response } } }
          : { description: 'Success' },
        ...Object.fromEntries(
          Object.entries(errorStatuses).map(([code, description]) => [
            code,
            { description, content: { 'application/json': { schema: errorResponseSchema } } },
          ]),
        ),
      },
    });

    const middlewares = [...(defaults.middlewares ?? []), ...(def.middlewares ?? [])];
    const handlers: RequestHandler[] = [
      ...middlewares,
      validate({ params: def.params, query: def.query, body: def.body }),
      async (req, res) => {
        const result = await handler(req as TypedRequest<P, Q, B>, res);
        if (res.headersSent || res.writableEnded) return;
        if (status === 204 || result === undefined || result === null) {
          res.status(status === 200 && result == null ? 204 : status).end();
          return;
        }
        let payload: unknown = result;
        if (def.response) {
          const parsed = def.response.safeParse(result);
          if (!parsed.success) {
            logger.error({ operationId: def.operationId, issues: parsed.error.issues }, 'Response failed schema validation');
            throw new Error(`Response for ${def.operationId} does not match its schema`);
          }
          payload = parsed.data;
        }
        res.status(status).json(payload);
      },
    ];
    router[def.method](def.path, ...handlers);
  }

  return { router, route };
}
