import { AsyncLocalStorage } from 'async_hooks';
import type { AiScope } from './types';

/**
 * Ambient scope of the current request.
 *
 * It is a bridge, not the destination: it carries the scope to the points of the
 * pipeline that do not receive it explicitly yet, while the migration is under
 * way. Where the context is already passed as a parameter, that takes
 * precedence.
 *
 * ⚠️ **It does not survive the Redis boundary.** A BullMQ job restarts in a
 * different async context, so every processor has to re-enter the store — that
 * is what `runWithSessionScope()` does, re-reading the guild from the database.
 * Without a scope there is no guessing: `requireAiScope()` throws.
 */

const storage = new AsyncLocalStorage<AiScope>();

export function runWithAiScope<T>(scope: AiScope, fn: () => T): T {
    return storage.run(scope, fn);
}

export function currentAiScope(): AiScope | undefined {
    return storage.getStore();
}

/**
 * Raised when an AI phase is resolved without knowing which table it is for.
 *
 * It is not a user configuration error: it is an entry point that forgot
 * `runWithAiScope()`, so the message speaks to whoever is developing.
 */
export class AiScopeMissingError extends Error {
    readonly code = 'AI_SCOPE_MISSING';

    constructor() {
        super(
            'Nessuno scope AI ambientale: non si sa quale tavolo paga questa ' +
            'chiamata. Il punto d\'ingresso deve entrare in runWithAiScope() ' +
            'con la gilda giusta.',
        );
        this.name = 'AiScopeMissingError';
    }
}

/**
 * The current scope. It is missing only when an entry point is not wired.
 *
 * **There is no fallback, and there is no instance scope.** Every AI call
 * belongs to a guild — including the technical end-of-session mail, which is
 * paid for by whoever started that session. There is no "us" that can pay on
 * somebody's behalf: if we do not know which table it is, we do not call.
 */
export function requireAiScope(): AiScope {
    const scope = storage.getStore();
    if (!scope) throw new AiScopeMissingError();
    return scope;
}
