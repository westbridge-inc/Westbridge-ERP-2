/**
 * Structured logger built on pino.
 * - JSON output in production
 * - Pretty-printed output in development
 * - Automatic redaction of sensitive fields
 * - Child logger factory for per-service context
 */
import pino from "pino";

const isDev = process.env.NODE_ENV === "development";

/** Fields that must never appear in log output. */
const REDACT_PATHS = [
  "password",
  "newPassword",
  "confirmPassword",
  "token",
  "resetToken",
  "inviteToken",
  "cookie",
  "authorization",
  "Authorization",
  "secret",
  "apiKey",
  "apiSecret",
  "erpnextSid",
  "creditCard",
  "cardNumber",
  "cvv",
  "ssn",
  "clientSecret",
  "passwordHash",
  "tokenHash",
  "*.password",
  "*.newPassword",
  "*.confirmPassword",
  "*.token",
  "*.cookie",
  "*.authorization",
  "*.Authorization",
  "*.secret",
  "*.apiKey",
  "*.apiSecret",
  "*.erpnextSid",
  "*.creditCard",
  "*.cardNumber",
  "*.cvv",
  "*.ssn",
  "*.clientSecret",
  "*.passwordHash",
  "*.tokenHash",
  "req.headers.cookie",
  "req.headers.authorization",
  "body.password",
  "body.newPassword",
  "body.confirmPassword",
  "body.token",
  "body.secret",
  "body.clientSecret",
];

const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {
        formatters: {
          level(label) {
            return { level: label };
          },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});

export type LogContext = {
  service?: string;
  traceId?: string;
  spanId?: string;
  userId?: string;
  accountId?: string;
  requestId?: string;
  duration_ms?: number;
  [key: string]: unknown;
};

/**
 * Create a child logger bound to a specific service context.
 * Usage: const log = logger.child({ service: 'auth', traceId });
 */
function child(context: LogContext) {
  return baseLogger.child(context);
}

export const logger = {
  trace: (msg: string, ctx?: LogContext) => baseLogger.trace(ctx ?? {}, msg),
  debug: (msg: string, ctx?: LogContext) => baseLogger.debug(ctx ?? {}, msg),
  info: (msg: string, ctx?: LogContext) => baseLogger.info(ctx ?? {}, msg),
  warn: (msg: string, ctx?: LogContext) => baseLogger.warn(ctx ?? {}, msg),
  error: (msg: string, ctx?: LogContext) => baseLogger.error(ctx ?? {}, msg),
  fatal: (msg: string, ctx?: LogContext) => baseLogger.fatal(ctx ?? {}, msg),
  child,
};

export type Logger = typeof logger;
