/**
 * A session's estimate.
 *
 * It answers the question a person asks **before** pressing «listen»:
 * how much is tonight going to cost me? Getting it wrong on the low side is worse than not giving it —
 * whoever reads it decides to record four hours on the basis of that number.
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { tenantAiSettingsRepository } from '../../../src/db/repositories/TenantAiSettingsRepository';
import { tenantSecretsRepository } from '../../../src/db/repositories/TenantSecretsRepository';
import { db } from '../../../src/db';
import { clearScopeCache } from '../../../src/bard/ai/scope';
import { SPEECH_TO_TEXT_PHASE, estimateSessionCost } from '../../../src/services/sessionCostEstimator';

const GUILD = 'gilda-preventivo';
const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

beforeEach(() => {
    process.env.SECRETS_MASTER_KEY = MASTER_KEY;
    wipeDatabase();
    clearScopeCache();
    campaignRepository.createCampaign(GUILD, 'Campagna');
});

afterAll(() => { delete process.env.SECRETS_MASTER_KEY; });

function withCloudTranscription(model = 'gpt-4o-mini-transcribe') {
    tenantSecretsRepository.put({ scope: 'guild', scopeId: GUILD, secretKey: 'openai.apiKey' }, 'sk-x');
    tenantAiSettingsRepository.put('guild', GUILD, {
        tiers: {
            quality: { provider: 'openai', model: 'gpt-5.6-terra' },
            fast: { provider: 'openai', model: 'gpt-5.4-mini' },
        },
        transcription: { engine: 'cloud', cloud: { provider: 'openai', model } },
    });
}

describe('preventivo di sessione', () => {
    it('quota la trascrizione al minuto, non a token', async () => {
        // It is often the largest line item of a long session: using the per-token
        // rate would give a figure wrong by orders of magnitude.
        withCloudTranscription();
        const estimate = await estimateSessionCost({ guildId: GUILD }, 240);

        const speech = estimate.perPhase.find(p => p.phase === SPEECH_TO_TEXT_PHASE)!;
        expect(speech.inputTokens).toBe(0);
        // 240 minuti × $0.003 = $0.72
        expect(speech.costUsd).toBeCloseTo(0.72, 4);
    });

    it('does not bill the transcript correction: the AI call behind it is dead code', async () => {
        // `correctTranscription()` (src/bard/transcription.ts) does only regex-based
        // hallucination cleanup today — the AI corrector (`correctTextOnly`) exists
        // but is wired into nothing. Pricing `transcription` here would charge for
        // work that structurally cannot happen. See CLAUDE.md.
        withCloudTranscription();
        const estimate = await estimateSessionCost({ guildId: GUILD }, 240);

        expect(estimate.perPhase.find(p => p.phase === 'transcription')).toBeUndefined();
        // Audio→text still gets its own line.
        expect(estimate.perPhase.filter(p => p.phase === SPEECH_TO_TEXT_PHASE)).toHaveLength(1);
    });

    it('counts every phase a session runs, none skipped', async () => {
        withCloudTranscription();
        const estimate = await estimateSessionCost({ guildId: GUILD }, 240);

        // `map` and `narrativeFilter` are absent too: neither has a live call site
        // anywhere in the codebase, agentic or legacy.
        expect(estimate.perPhase.map(p => p.phase)).toEqual([
            SPEECH_TO_TEXT_PHASE, 'metadata', 'analyst', 'manifesto',
            'summary', 'moral_reassessment', 'bio_batch', 'reconcile', 'embedding',
        ]);
    });

    it('grows with the duration', async () => {
        withCloudTranscription();
        const short = await estimateSessionCost({ guildId: GUILD }, 60);
        const long = await estimateSessionCost({ guildId: GUILD }, 240);

        expect(long.totalUsd!).toBeGreaterThan(short.totalUsd!);
    });

    it('the table\'s PC costs nothing, but is declared as effortful', async () => {
        // «€0» on a phase that keeps a home computer busy for twenty
        // minutes is a half-truth.
        tenantAiSettingsRepository.put('guild', GUILD, {
            transcription: { engine: 'remote', remote: { url: 'http://pc:3001' } },
        });
        tenantSecretsRepository.put({ scope: 'guild', scopeId: GUILD, secretKey: 'openai.apiKey' }, 'sk-x');

        const estimate = await estimateSessionCost({ guildId: GUILD }, 120);
        const speech = estimate.perPhase.find(p => p.phase === SPEECH_TO_TEXT_PHASE)!;

        expect(speech.costUsd).toBe(0);
        expect(speech.resourceIntensive).toBe(true);
        expect(estimate.resourceIntensivePhases).toContain(SPEECH_TO_TEXT_PHASE);
    });

    it('a model with an unknown price makes the total incomplete, not lower', async () => {
        // The defect this phase closes: a missing price sliding to
        // zero lowers the total and makes the session look cheaper.
        tenantSecretsRepository.put({ scope: 'guild', scopeId: GUILD, secretKey: 'openai.apiKey' }, 'sk-x');
        tenantAiSettingsRepository.put('guild', GUILD, {
            tiers: { quality: { provider: 'openai', model: 'gpt-mai-visto' } },
            transcription: { engine: 'cloud', cloud: { provider: 'openai', model: 'gpt-4o-mini-transcribe' } },
        });

        const estimate = await estimateSessionCost({ guildId: GUILD }, 120);

        expect(estimate.pricingComplete).toBe(false);
        expect(estimate.totalUsd).toBeNull();
        expect(estimate.perPhase.find(p => p.phase === 'analyst')!.pricingSource).toBe('unknown');
    });

    it('with no history it says so, rather than passing a guess off as a measurement', async () => {
        withCloudTranscription();
        const estimate = await estimateSessionCost({ guildId: GUILD }, 120);
        expect(estimate.calibrated).toBe(false);
    });

    it('calibrates on the table\'s own history once there is enough of it', async () => {
        // A group of six people talking over each other produces three times the
        // text of a duo: the global average describes neither of them.
        withCloudTranscription();

        for (let i = 1; i <= 4; i++) {
            const sessionId = `sess-${i}`;
            // The duration is derived from the span of the recordings: 60 minutes.
            db.prepare('INSERT INTO recordings (session_id, filename, filepath, timestamp) VALUES (?, ?, ?, ?)')
                .run(sessionId, `${sessionId}-a.flac`, '/a.flac', 0);
            db.prepare('INSERT INTO recordings (session_id, filename, filepath, timestamp) VALUES (?, ?, ?, ?)')
                .run(sessionId, `${sessionId}-b.flac`, '/b.flac', 60 * 60_000);
            db.prepare(`
                INSERT INTO ai_usage_log (session_id, guild_id, phase, provider, model,
                    input_tokens, output_tokens, cost_usd, created_at)
                VALUES (?, ?, 'analyst', 'openai', 'gpt-5.6-terra', ?, ?, 0, ?)
            `).run(sessionId, GUILD, 600_000, 60_000, Date.now());
        }

        const estimate = await estimateSessionCost({ guildId: GUILD }, 60);
        const analyst = estimate.perPhase.find(p => p.phase === 'analyst')!;

        expect(estimate.calibrated).toBe(true);
        // 10.000 token/minuto osservati, contro i 1.400 di default.
        expect(analyst.inputTokens).toBe(600_000);
    });

    it('a single session does not make a median', async () => {
        withCloudTranscription();
        db.prepare('INSERT INTO recordings (session_id, filename, filepath, timestamp) VALUES (?, ?, ?, ?)')
            .run('sess-unica', 'a.flac', '/a.flac', 0);
        db.prepare('INSERT INTO recordings (session_id, filename, filepath, timestamp) VALUES (?, ?, ?, ?)')
            .run('sess-unica', 'b.flac', '/b.flac', 60 * 60_000);
        db.prepare(`
            INSERT INTO ai_usage_log (session_id, guild_id, phase, provider, model,
                input_tokens, output_tokens, cost_usd, created_at)
            VALUES ('sess-unica', ?, 'analyst', 'openai', 'gpt-5.6-terra', 999999, 0, 0, ?)
        `).run(GUILD, Date.now());

        const estimate = await estimateSessionCost({ guildId: GUILD }, 60);
        expect(estimate.calibrated).toBe(false);
    });

    it('honours the rates declared by the table', async () => {
        withCloudTranscription();
        const before = await estimateSessionCost({ guildId: GUILD }, 120);

        const current = tenantAiSettingsRepository.get('guild', GUILD)!.settings as Record<string, unknown>;
        tenantAiSettingsRepository.put('guild', GUILD, {
            ...current,
            pricingOverrides: [{ model: 'gpt-5*', inputPerMillion: 0, outputPerMillion: 0 }],
        });
        const after = await estimateSessionCost({ guildId: GUILD }, 120);

        expect(after.totalUsd!).toBeLessThan(before.totalUsd!);
        expect(after.perPhase.find(p => p.phase === 'analyst')!.pricingSource).toBe('tenant_override');
    });
});
