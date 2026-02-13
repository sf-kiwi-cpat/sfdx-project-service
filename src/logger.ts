import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  transport:
    process.env.NODE_ENV === 'test'
      ? undefined
      : {
          target: 'pino/file',
          options: { destination: 1 },
        },
  formatters: {
    level: (label) => ({ level: label }),
  },
});
