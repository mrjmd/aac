/**
 * Standardized JSON logging for all apps.
 *
 * Outputs structured JSON that the Command Center can ingest.
 *
 * TODO: Extract from aac-slim/src/lib/logger.ts during Phase 0.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: unknown, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

/**
 * Create a structured JSON logger.
 */
export function createLogger(module: string): Logger {
  const log = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      ...context,
    };
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      JSON.stringify(entry)
    );
  };

  return {
    debug: (msg, ctx) => log('debug', msg, ctx),
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, err, ctx) => {
      const errorContext = err instanceof Error
        ? { error: err.message, stack: err.stack, ...ctx }
        : { error: String(err), ...ctx };
      log('error', msg, errorContext);
    },
    child: (childCtx) => {
      const childLogger = createLogger(module);
      const wrap = (fn: Function, ...args: unknown[]) => {
        const lastArg = args[args.length - 1];
        const merged = typeof lastArg === 'object' ? { ...childCtx, ...lastArg as object } : childCtx;
        return fn(args[0], merged);
      };
      return {
        debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, { ...childCtx, ...ctx }),
        info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, { ...childCtx, ...ctx }),
        warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, { ...childCtx, ...ctx }),
        error: (msg: string, err?: unknown, ctx?: Record<string, unknown>) => {
          childLogger.error(msg, err, { ...childCtx, ...ctx });
        },
        child: (nestedCtx) => createLogger(module), // TODO: proper nesting
      } satisfies Logger;
    },
  };
}
