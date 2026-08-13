import { Client, TextChannel } from 'discord.js';
import { Job, Worker } from 'bullmq';
import { getGuildConfig } from '../db';
import { waitForCompletionAndSummarize } from '../publisher';
import { monitor } from '../monitor';
import { logger } from '../utils/logger';
import { queueConnection } from './queue';
import { sessionPhaseManager } from './SessionPhaseManager';
import type { SessionFinalizationJobData } from './sessionProcessing';

const log = logger('SessionFinalization');

async function resolveNotificationChannel(
    client: Client,
    data: SessionFinalizationJobData,
): Promise<TextChannel | undefined> {
    const channelId = data.channelId
        || getGuildConfig(data.guildId, 'summary_channel_id')
        || getGuildConfig(data.guildId, 'cmd_channel_id');
    if (!channelId) return undefined;

    try {
        const channel = await client.channels.fetch(channelId);
        return channel?.isTextBased() ? channel as TextChannel : undefined;
    } catch (error) {
        log.warn(`Canale ${channelId} non accessibile; finalizzo senza notifica Discord`, { guildId: data.guildId });
        return undefined;
    }
}

export function startFinalizationWorker(client: Client): Worker<SessionFinalizationJobData> | null {
    if (process.env.DISABLE_REDIS === 'true') return null;

    const worker = new Worker<SessionFinalizationJobData>(
        'session-finalization',
        async (job: Job<SessionFinalizationJobData>) => {
            const phase = sessionPhaseManager.getPhase(job.data.sessionId)?.phase;
            if (phase === 'DONE') return { status: 'already_done' };

            monitor.startSession(job.data.sessionId, job.data.metrics);
            monitor.setRuntimePhase(job.data.sessionId, 'finalization');
            const channel = await resolveNotificationChannel(client, job.data);
            await waitForCompletionAndSummarize(client, job.data.sessionId, channel);
            return { status: 'done' };
        },
        {
            connection: queueConnection,
            concurrency: 1,
            lockDuration: 2 * 60 * 60 * 1000,
            lockRenewTime: 30_000,
            maxStalledCount: 1,
        },
    );

    worker.on('failed', (job, error) => {
        log.error(`Finalizzazione fallita per ${job?.data.sessionId || job?.id}`, error);
    });
    const shutdown = () => void worker.close();
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    log.info('Worker finalizzazione avviato sul gateway (concurrency=1)');
    return worker;
}
