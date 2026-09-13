import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'cookieAuth', {
  type: 'apiKey',
  in: 'cookie',
  name: 'rt_access',
  description: 'Access token cookie set by /v1/auth/login. The admin app reaches this API via a same-origin rewrite.',
});
registry.registerComponent('securitySchemes', 'webKey', {
  type: 'apiKey',
  in: 'header',
  name: 'x-web-key',
  description: 'Shared secret used by rental-web server-side calls.',
});
registry.registerComponent('securitySchemes', 'cronSecret', {
  type: 'http',
  scheme: 'bearer',
  description: 'Vercel Cron bearer secret.',
});

export const errorResponseSchema = registry.register(
  'ErrorResponse',
  z.object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    }),
  }),
);

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Rental Platform API',
      version: '1.0.0',
      description:
        'Backend for the multi-tenant rental platform. Errors are always `{ error: { code, message, issues? } }`. Money is integer IDR. Timestamps are ISO-8601 with timezone.',
    },
    servers: [{ url: '/', description: 'Same origin (via rewrite) or the deployed API host' }],
    tags: [
      { name: 'Auth', description: 'Owner/staff/superadmin authentication' },
      { name: 'Public', description: 'Storefront endpoints, no authentication' },
      { name: 'Admin', description: 'Tenant-scoped management for owners and staff' },
      { name: 'Platform', description: 'Superadmin-only' },
      { name: 'Internal', description: 'Cron and machine-to-machine' },
      { name: 'Meta', description: 'Static metadata' },
    ],
  });
}
