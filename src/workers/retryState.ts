/**
 * BullMQ exposes `attemptsMade` as the number of attempts already consumed
 * before the currently running processor invocation.  A recording must not be
 * made terminal while BullMQ still intends to retry it: the session
 * orchestrator watches that same DB status.
 */
export function isFinalAttempt(attemptsMade: number, configuredAttempts?: number): boolean {
    const maxAttempts = Math.max(1, configuredAttempts ?? 1);
    return attemptsMade + 1 >= maxAttempts;
}
