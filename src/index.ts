#!/usr/bin/env node
import { createApp } from './app.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const app = createApp();

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  logger.info({ port: PORT }, 'SF Project Service listening');
} catch (err) {
  logger.error(err, 'Failed to start server');
  process.exit(1);
}
