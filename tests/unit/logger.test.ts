import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('logger', () => {
  let originalNodeEnv: string | undefined;
  let originalLogLevel: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalLogLevel = process.env.LOG_LEVEL;
  });

  afterEach(() => {
    // Restore env
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    vi.restoreAllMocks();
  });

  async function importLogger(env: Record<string, string | undefined>) {
    // Set env before importing
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    // Reset module registry so logger.ts re-evaluates
    vi.resetModules();

    // Mock pino to capture constructor args
    const pinoArgs: { level: string; transport: unknown }[] = [];
    vi.doMock('pino', () => ({
      default: (opts: { level: string; transport: unknown }) => {
        pinoArgs.push(opts);
        return opts; // return a stub
      },
    }));

    await import('../../src/logger.js');
    return pinoArgs[0];
  }

  it('uses silent level and no transport when NODE_ENV=test', async () => {
    const opts = await importLogger({ NODE_ENV: 'test', LOG_LEVEL: undefined });
    expect(opts.level).toBe('silent');
    expect(opts.transport).toBeUndefined();
  });

  it('uses debug level and pino/file transport when NODE_ENV=development', async () => {
    const opts = await importLogger({ NODE_ENV: 'development', LOG_LEVEL: undefined });
    expect(opts.level).toBe('debug');
    expect(opts.transport).toEqual({ target: 'pino/file', options: { destination: 1 } });
  });

  it('uses info level when NODE_ENV=production', async () => {
    const opts = await importLogger({ NODE_ENV: 'production', LOG_LEVEL: undefined });
    expect(opts.level).toBe('info');
  });

  it('uses LOG_LEVEL when set (overrides default)', async () => {
    const opts = await importLogger({ NODE_ENV: 'production', LOG_LEVEL: 'warn' });
    expect(opts.level).toBe('warn');
  });
});
