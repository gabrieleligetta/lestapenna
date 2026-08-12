/**
 * Structured Logger - Minimal wrapper over console with timestamp, level, and optional guildId.
 * Zero dependencies. Output is JSON-ish single-line for easy parsing.
 *
 * Usage:
 *   import { logger } from '../utils/logger';
 *   const log = logger('Recorder');
 *   log.info('Session started', { guildId: '123', sessionId: 'abc' });
 *   // => [2026-03-20T14:30:00.000Z] INFO  [Recorder] Session started | guildId=123 sessionId=abc
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVELS: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL?.toUpperCase() as LogLevel) || 'INFO';

interface LogContext {
    guildId?: string;
    sessionId?: string;
    [key: string]: unknown;
}

function formatContext(ctx?: LogContext): string {
    if (!ctx) return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(ctx)) {
        if (value !== undefined && value !== null) {
            parts.push(`${key}=${value}`);
        }
    }
    return parts.length > 0 ? ` | ${parts.join(' ')}` : '';
}

function formatTimestamp(): string {
    return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export interface Logger {
    debug(msg: string, ctx?: LogContext): void;
    info(msg: string, ctx?: LogContext): void;
    warn(msg: string, ctx?: LogContext): void;
    error(msg: string, ctx?: LogContext | Error, error?: Error): void;
}

export function logger(module: string): Logger {
    const prefix = `[${module}]`;

    return {
        debug(msg: string, ctx?: LogContext) {
            if (!shouldLog('DEBUG')) return;
            console.debug(`[${formatTimestamp()}] DEBUG ${prefix} ${msg}${formatContext(ctx)}`);
        },

        info(msg: string, ctx?: LogContext) {
            if (!shouldLog('INFO')) return;
            console.log(`[${formatTimestamp()}] INFO  ${prefix} ${msg}${formatContext(ctx)}`);
        },

        warn(msg: string, ctx?: LogContext) {
            if (!shouldLog('WARN')) return;
            console.warn(`[${formatTimestamp()}] WARN  ${prefix} ${msg}${formatContext(ctx)}`);
        },

        error(msg: string, ctxOrError?: LogContext | Error, error?: Error) {
            if (!shouldLog('ERROR')) return;
            let ctx: LogContext | undefined;
            let err: Error | undefined;

            if (ctxOrError instanceof Error) {
                err = ctxOrError;
            } else {
                ctx = ctxOrError;
                err = error;
            }

            const errStr = err ? ` | error=${err.message}` : '';
            console.error(`[${formatTimestamp()}] ERROR ${prefix} ${msg}${formatContext(ctx)}${errStr}`);
            if (err?.stack && shouldLog('DEBUG')) {
                console.error(err.stack);
            }
        },
    };
}
