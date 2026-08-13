export type ProcessRole = 'all' | 'gateway' | 'worker';

/**
 * `all` preserves the single-process self-hosting experience. Production uses
 * two containers from the same image and selects one responsibility per
 * process, so CPU-heavy work cannot block Discord's event loop.
 */
export function getProcessRole(): ProcessRole {
    const value = (process.env.PROCESS_ROLE || 'all').trim().toLowerCase();
    if (value === 'all' || value === 'gateway' || value === 'worker') return value;
    throw new Error(`Invalid PROCESS_ROLE=${process.env.PROCESS_ROLE}; expected all, gateway or worker`);
}

export const processRunsGateway = () => getProcessRole() !== 'worker';
export const processRunsWorkers = () => getProcessRole() !== 'gateway';
