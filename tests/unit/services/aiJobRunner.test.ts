/**
 * The runner, and the two promises it keeps.
 *
 * Everything here is about somebody else's money: the work must run exactly
 * once, and what a crash left behind must never be run again — because a job
 * that was interrupted cannot be told apart from one the provider already served
 * and billed.
 */
import { createCampaign, deleteCampaign } from '../../../src/db';
import { aiJobRepository, type AiJobRow } from '../../../src/db/repositories/AiJobRepository';
import { AiJobRunner } from '../../../src/services/aiJobs/runner';
import { AiJobFailure, type AiJobHandler } from '../../../src/services/aiJobs/types';
import { currentAiScope } from '../../../src/bard/ai/ambientScope';

describe('ai job runner', () => {
    let campaignId: number;

    beforeAll(() => {
        campaignId = createCampaign('runner-guild', 'Test AI Job Runner');
    });

    afterAll(() => {
        try { deleteCampaign(campaignId); } catch { /* already gone */ }
    });

    /** A runner wired to one handler, standing in for all four kinds. */
    function runnerWith(handler: AiJobHandler): AiJobRunner {
        return new AiJobRunner({
            'image': handler,
            'appearance': handler,
            'quest-audit': handler,
            'character-bio': handler,
        });
    }

    const enqueue = (targetKey: string) => aiJobRepository.enqueue({
        campaignId,
        kind: 'image',
        targetType: 'npc',
        targetKey,
        requestedBy: 'someone',
        params: { rawType: 'npc', entityId: targetKey },
    });

    it('runs a job once and records what it produced', async () => {
        const run = jest.fn<Promise<never>, [AiJobRow]>().mockResolvedValue({
            status: 'awaiting_review',
            originalKey: 'ai-jobs/g/1/x/original.webp',
            displayKey: 'ai-jobs/g/1/x/display.webp',
            summary: { width: 768 },
        } as never);
        const job = enqueue('once');

        await runnerWith({ run }).waitForIdle();

        expect(run).toHaveBeenCalledTimes(1);
        const finished = aiJobRepository.getById(job.id)!;
        expect(finished.status).toBe('awaiting_review');
        expect(finished.result_display_key).toBe('ai-jobs/g/1/x/display.webp');
        // Something to accept means something to lose: it gets a deadline.
        expect(finished.expires_at).toBeGreaterThan(Date.now());
    });

    it('runs the work inside the campaign\'s own AI scope', async () => {
        // Without this the pipeline would resolve no scope and throw — which is
        // the correct failure, because there is no "us" that can pay for a table.
        let seen: unknown;
        const run = jest.fn(async () => {
            seen = currentAiScope();
            return { status: 'succeeded' } as never;
        });
        enqueue('scoped');

        await runnerWith({ run }).waitForIdle();

        expect(seen).toEqual({ guildId: 'runner-guild', campaignId });
    });

    it('classifies a failure so the answer says what to do about it', async () => {
        const overloaded: any = new Error(JSON.stringify({ error: { code: 503 } }));
        overloaded.status = 503;
        const run = jest.fn()
            .mockRejectedValueOnce(new AiJobFailure('refused', 'blocked by the safety filter'))
            .mockRejectedValueOnce(overloaded);

        const refused = enqueue('refused');
        const unreachable = enqueue('unreachable');
        await runnerWith({ run }).waitForIdle();

        expect(aiJobRepository.getById(refused.id)).toMatchObject({
            status: 'failed', error_kind: 'refused',
        });
        expect(aiJobRepository.getById(unreachable.id)).toMatchObject({
            status: 'failed', error_kind: 'provider',
        });
    });

    it('does not retry a failure, because a paid call is not free to repeat', async () => {
        const run = jest.fn().mockRejectedValue(new Error('the provider hung up'));
        enqueue('noretry');

        const runner = runnerWith({ run });
        await runner.waitForIdle();
        // A second pass finds nothing: a failed job is finished, not pending.
        await runner.waitForIdle();

        expect(run).toHaveBeenCalledTimes(1);
    });

    it('closes what a restart interrupted, and never runs it again', async () => {
        const run = jest.fn().mockResolvedValue({ status: 'succeeded' } as never);
        const abandoned = enqueue('abandoned');
        // The state a killed process leaves behind.
        aiJobRepository.claim(abandoned.id);

        const runner = runnerWith({ run });
        runner.start();
        try {
            await runner.waitForIdle();
        } finally {
            runner.stop();
        }

        expect(aiJobRepository.getById(abandoned.id)).toMatchObject({
            status: 'failed', error_kind: 'interrupted',
        });
        // The point of the whole design: it is not picked up and paid for twice.
        expect(run).not.toHaveBeenCalled();
    });

    it('cannot record work for a campaign that does not exist', async () => {
        // The foreign key is what guarantees the runner always has a guild to
        // resolve — and therefore somebody whose account is being spent. There
        // is no fallback scope on purpose: if we do not know which table it is,
        // we do not call.
        expect(() => aiJobRepository.enqueue({
            campaignId: 999_999,
            kind: 'image',
            targetType: 'npc',
            targetKey: 'orphan',
            requestedBy: 'someone',
            params: {},
        })).toThrow(/FOREIGN KEY/i);
    });
});
