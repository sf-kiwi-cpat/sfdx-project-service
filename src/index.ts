#!/usr/bin/env node
import { createApp } from './app.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const app = createApp();

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'SF Project Service listening');
});
