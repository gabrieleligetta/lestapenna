/**
 * The register of paid AI work.
 *
 * Two properties are worth testing hard, because they are the reasons the table
 * exists: a second job on the same target is impossible, and a job a crash left
 * behind is closed rather than re-run. Both protect the same thing — somebody
 * else's provider account.
 */
import { createCampaign, deleteCampaign } from '../../../src/db';
import {
    ActiveJobExistsError,
    aiJobRepository,
    parseAiJobParams,
} from '../../../src/db/repositories/AiJobRepository';

describe('ai job register', () => {
    let campaignId: number;

    beforeAll(() => {
        campaignId = createCampaign('Test AI Jobs', 'test-guild');
    });

    afterAll(() => {
        try { deleteCampaign(campaignId); } catch { /* already gone */ }
    });

    const request = (overrides: Partial<Parameters<typeof aiJobRepository.enqueue>[0]> = {}) =>
        aiJobRepository.enqueue({
            campaignId,
            kind: 'image',
            targetType: 'npc',
            targetKey: 'astr1',
            targetLabel: 'Astrid Foe',
            requestedBy: 'someone',
            params: { mode: 'auto', shot: { framing: 'full' } },
            ...overrides,
        });

    test('a job starts queued, owned, and carrying its exact request', () => {
        const job = request();

        expect(job.status).toBe('queued');
        expect(job.requested_by).toBe('someone');
        // The runner executes after the HTTP response is gone, so the input has
        // to survive on the row rather than in a closure.
        expect(parseAiJobParams<{ mode: string }>(job)?.mode).toBe('auto');
        expect(job.usage_run_id).toBeNull();
    });

    test('a second job on the same target is refused while the first is alive', () => {
        expect(() => request()).toThrow(ActiveJobExistsError);

        // A different entity, and a different kind on the same entity, are both
        // fine: the lock is per target and per kind, not a global queue.
        expect(request({ targetKey: 'other' }).status).toBe('queued');
        expect(request({ kind: 'appearance' }).status).toBe('queued');
    });

    test('only one claim of a job can win', () => {
        const job = request({ targetKey: 'claimme' });

        expect(aiJobRepository.claim(job.id)).toBe(true);
        expect(aiJobRepository.claim(job.id)).toBe(false);
        expect(aiJobRepository.getById(job.id)?.status).toBe('running');
    });

    test('the target is free again once the job is finished', () => {
        const first = request({ targetKey: 'freeagain' });
        aiJobRepository.claim(first.id);
        aiJobRepository.markFailed(first.id, 'provider', 'the model was busy');

        expect(() => request({ targetKey: 'freeagain' })).not.toThrow();
    });

    test('a job the provider answered records that the money is gone', () => {
        const job = request({ targetKey: 'paid' });
        aiJobRepository.claim(job.id);
        aiJobRepository.recordSpend(job.id, {
            usageRunId: `AIJOB:${job.id}`,
            provider: 'gemini',
            model: 'gemini-3-pro-image',
            pricingAvailable: false,
        });

        const paid = aiJobRepository.getById(job.id)!;
        // A model with no published price writes no ledger row at all, so this
        // is the only surviving trace that the call happened.
        expect(paid.usage_run_id).toBe(`AIJOB:${job.id}`);
        expect(paid.pricing_available).toBe(0);
    });

    test('a crash closes what was running, and never runs it again', () => {
        const job = request({ targetKey: 'crashed' });
        aiJobRepository.claim(job.id);
        const queued = request({ targetKey: 'untouched' });

        expect(aiJobRepository.failInterrupted()).toBeGreaterThanOrEqual(1);

        const closed = aiJobRepository.getById(job.id)!;
        expect(closed.status).toBe('failed');
        expect(closed.error_kind).toBe('interrupted');
        // It says so out loud: this is the one outcome where we cannot promise
        // the table was not charged.
        expect(closed.error_message).toMatch(/may already have been charged/i);
        // A queued job never reached a provider, so a restart leaves it alone.
        expect(aiJobRepository.getById(queued.id)?.status).toBe('queued');
    });

    test('the bell counts finished work nobody has looked at yet', () => {
        const mine = request({ targetKey: 'unseen1', requestedBy: 'reader' });
        aiJobRepository.claim(mine.id);
        aiJobRepository.markSucceeded(mine.id);
        const running = request({ targetKey: 'unseen2', requestedBy: 'reader' });
        aiJobRepository.claim(running.id);

        expect(aiJobRepository.countUnseen('reader')).toBe(1);
        expect(aiJobRepository.countActive('reader')).toBe(1);

        // Marking seen must not silence the job still running: its outcome has
        // not happened yet, and that is the notification the person is waiting for.
        expect(aiJobRepository.markSeen('reader')).toBe(1);
        expect(aiJobRepository.countUnseen('reader')).toBe(0);
        aiJobRepository.markSucceeded(running.id);
        expect(aiJobRepository.countUnseen('reader')).toBe(1);
    });

    test('an unclaimed result expires without taking its record with it', () => {
        const job = request({ targetKey: 'expiring' });
        aiJobRepository.claim(job.id);
        aiJobRepository.markAwaitingReview(job.id, {
            originalKey: 'ai-jobs/g/1/x/original',
            displayKey: 'ai-jobs/g/1/x/display.webp',
            expiresAt: Date.now() - 1,
        });

        const due = aiJobRepository.listExpired();
        expect(due.map(row => row.id)).toContain(job.id);

        aiJobRepository.markExpired(job.id);
        const expired = aiJobRepository.getById(job.id)!;
        expect(expired.status).toBe('expired');
        // The keys are cleared because the objects are gone; the row stays,
        // because "you paid for this and did not take it" is information.
        expect(expired.result_display_key).toBeNull();
    });

    test('the cooldown clock survives anything a process forgets', () => {
        const job = request({ kind: 'quest-audit', targetType: 'campaign', targetKey: 'campaign' });
        aiJobRepository.claim(job.id);
        aiJobRepository.markSucceeded(job.id, { suggestions: 2 });

        const last = aiJobRepository.lastFinishedAt(campaignId, 'quest-audit');
        expect(last).toBeGreaterThan(0);
        expect(aiJobRepository.lastFinishedAt(campaignId, 'character-bio')).toBeNull();
    });
});
