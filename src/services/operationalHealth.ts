import * as os from 'os';
import { Client } from 'discord.js';
import { db } from '../db/client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { checkDiskSpace } from '../monitor/utils';
import { getActiveRecordingCount } from '../state/sessionState';
import {
    audioQueue,
    correctionQueue,
    sessionFinalizationQueue,
    sessionProcessingQueue,
} from './queue';
import { getProcessRole } from './processRole';

const log = logger('OperationalHealth');
const LAG_SAMPLE_MS = 1000;
let eventLoopLagMs = 0;
let lastCriticalSignature = '';

const lagTimer = setInterval(() => {
    const expected = Date.now() + LAG_SAMPLE_MS;
    setTimeout(() => {
        eventLoopLagMs = Math.max(0, Date.now() - expected);
    }, LAG_SAMPLE_MS).unref?.();
}, LAG_SAMPLE_MS);
lagTimer.unref?.();

async function queueState(queue: any) {
    const counts = await queue.getJobCounts();
    const waiting = await queue.getJobs(['waiting', 'delayed'], 0, 0, true);
    const oldest = waiting[0]?.timestamp as number | undefined;
    return {
        waiting: (counts.waiting || 0) + (counts.delayed || 0),
        active: counts.active || 0,
        failed: counts.failed || 0,
        oldestWaitingMs: oldest ? Math.max(0, Date.now() - oldest) : 0,
    };
}

export async function getOperationalHealth() {
    const [audio, correction, sessions, finalization, activeRecordings] = await Promise.all([
        queueState(audioQueue),
        queueState(correctionQueue),
        queueState(sessionProcessingQueue),
        queueState(sessionFinalizationQueue),
        getActiveRecordingCount(),
    ]);
    const freeRamMB = Math.round(os.freemem() / 1024 / 1024);
    const disk = checkDiskSpace();
    const database = db.prepare(`
        SELECT
          SUM(CASE WHEN processing_phase = 'ERROR' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN processing_phase NOT IN ('IDLE', 'DONE', 'ERROR', '')
                    AND processing_phase IS NOT NULL
                    AND phase_started_at < ? THEN 1 ELSE 0 END) AS stuck
        FROM sessions
    `).get(Date.now() - 2 * 60 * 60 * 1000) as { failed: number | null; stuck: number | null };

    const criticalReasons = [
        ...(eventLoopLagMs > 500 ? [`event_loop_lag=${eventLoopLagMs}ms`] : []),
        ...(freeRamMB < 2048 ? [`free_ram=${freeRamMB}MB`] : []),
        ...(disk && disk.freeGB < 5 ? [`free_disk=${disk.freeGB.toFixed(1)}GB`] : []),
    ];

    return {
        status: criticalReasons.length > 0 ? 'degraded' : 'ok',
        role: getProcessRole(),
        timestamp: new Date().toISOString(),
        activeRecordings,
        eventLoopLagMs,
        freeRamMB,
        loadAverage1m: Number(os.loadavg()[0].toFixed(2)),
        disk,
        sessions: { failed: database.failed || 0, stuck: database.stuck || 0 },
        queues: { sessions, audio, correction, finalization },
        criticalReasons,
    };
}

/** Sends one DM on entering/changing a critical state, never once per tick. */
export function startOperationalAlerts(client: Client): void {
    const check = async () => {
        try {
            const health = await getOperationalHealth();
            const signature = health.criticalReasons.sort().join('|');
            if (!signature) {
                lastCriticalSignature = '';
                return;
            }
            if (signature === lastCriticalSignature) return;
            lastCriticalSignature = signature;
            log.error(`Infrastructure degraded: ${health.criticalReasons.join(', ')}`);
            if (!config.discord.developerId) return;
            const developer = await client.users.fetch(config.discord.developerId);
            await developer.send(`🚨 **Lestapenna infrastructure degraded**\n${health.criticalReasons.join('\n')}`);
        } catch (error) {
            log.warn(`Operational health check failed: ${(error as Error).message}`);
        }
    };
    const timer = setInterval(() => void check(), 60_000);
    timer.unref?.();
    void check();
}
