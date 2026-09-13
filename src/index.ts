import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { requestId } from './middleware/request-id.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { routes } from './routes.js';
import { logger } from './lib/logger.js';

const app = express();

// Behind Vercel's proxy: makes req.ip / req.secure / req.protocol reflect the client.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('etag', false);

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(requestId);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());

// Vercel serves public/ from its CDN and ignores express.static; this only matters for local dev.
app.use(express.static(path.join(process.cwd(), 'public'), { index: false }));

app.get('/', (_req, res) => {
  res.json({ name: 'rental-api', version: 1, docs: '/openapi.json' });
});

app.use('/v1', routes);

app.use(notFoundHandler);
app.use(errorHandler);

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});

export default app;
