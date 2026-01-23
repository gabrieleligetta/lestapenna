/**
 * Monitor - Memory Logic
 */

import * as os from 'os';
// import { monitor } from './engine'; // Avoid circular dependency here, pass monitor or callback if needed

export enum MemoryStatus {
    HEALTHY = 'HEALTHY',      // > 20% RAM libera
    WARNING = 'WARNING',      // 10-20% RAM libera
    CRITICAL = 'CRITICAL'     // < 10% RAM libera
}

export function getMemoryStatus(): { status: MemoryStatus; freeGB: number; freePercent: number } {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const freePercent = (freeMem / totalMem) * 100;
    const freeGB = freeMem / (1024 ** 3);

    let status = MemoryStatus.HEALTHY;
    if (freePercent < 20) status = MemoryStatus.WARNING;
    if (freePercent < 10) status = MemoryStatus.CRITICAL;

    return { status, freeGB, freePercent };
}

// Note: startMemoryMonitor depends on 'monitor' singleton to log errors. 
// We will implement it in index or engine to avoid circular deps.
