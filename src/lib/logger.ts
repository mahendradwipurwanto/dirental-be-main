import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.isTest ? 'silent' : env.isProd ? 'info' : 'debug',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env.isProd || env.VERCEL_ENV
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});

export type Logger = typeof logger;
