/**
 * Monitor - Index (Singleton Export)
 */

import { SystemMonitor } from './engine';
import { getMemoryStatus, MemoryStatus } from './memory';

export const monitor = new SystemMonitor();

// Re-exports
export * from './types';
export * from './memory';
export * from './engine';

export function startMemoryMonitor(): NodeJS.Timeout {
    console.log('[MemMonitor] 📊 Avvio monitor memoria (check ogni 2 min)...');

    return setInterval(() => {
        const mem = getMemoryStatus();

        if (mem.status !== MemoryStatus.HEALTHY) {
            console.warn(`[MemMonitor] RAM: ${mem.freeGB.toFixed(2)} GB liberi (${mem.freePercent.toFixed(1)}%) - Status: ${mem.status}`);
            monitor.logError('Memory', `Low RAM: ${mem.freePercent.toFixed(1)}%`);
        }
    }, 120000); // Ogni 2 minuti
}
