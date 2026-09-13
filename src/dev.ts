import app from './index.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

app.listen(env.PORT, () => {
  logger.info(`rental-api listening on http://localhost:${env.PORT}`);
});
