import pino from 'pino'

export const logger = pino({
  base: undefined,
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.phone',
      '*.phoneNumber',
      '*.otp',
      '*.code',
      '*.password',
      '*.secret',
      '*.token',
      '*.document',
      '*.credential',
    ],
    censor: '[REDACTED]',
  },
})
