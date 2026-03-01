import type { FastifyInstance } from 'fastify';

import { loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { buildServer, routeManifest } from './server.js';

let shuttingDown = false;

async function shutdown(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('Shutdown signal received', { signal });
  try {
    const app = await serverPromise;
    await app.close();
    logger.info('API shutdown complete', { signal });
  } catch (error) {
    logger.error('API shutdown error', {
      signal,
      error: String(error)
    });
    process.exitCode = 1;
  }
}

async function main(): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = await buildServer({ env });

  await app.listen({
    host: '0.0.0.0',
    port: env.port
  });

  const routeCount = Object.values(routeManifest).reduce((sum, routes) => sum + routes.length, 0);

  logger.info('API started', {
    nodeEnv: env.nodeEnv,
    port: env.port,
    routeCount
  });

  return app;
}

const serverPromise = main();

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

serverPromise.catch((error) => {
  logger.error('Fatal startup error', { error: String(error) });
  process.exitCode = 1;
});
