/**
 * The BYOK gate.
 *
 * A table with no keys must not be able to start anything. The reason is concrete:
 * a `$listen` that starts without keys produces hours of audio nobody will be able to
 * transcribe or summarize, and that session really is lost — whereas an
 * immediate refusal costs a second and says what to do.
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { tenantSecretsRepository } from '../../../src/db/repositories/TenantSecretsRepository';
import { tenantAiSettingsRepository } from '../../../src/db/repositories/TenantAiSettingsRepository';
import { checkAiReadiness } from '../../../src/bard/ai/readiness';
import { clearScopeCache } from '../../../src/bard/ai/scope';

const GUILD = 'gilda-di-prova';
const MASTER_KEY = Buffer.alloc(32, 3).toString('base64');

beforeEach(() => {
    process.env.SECRETS_MASTER_KEY = MASTER_KEY;
    wipeDatabase();
    clearScopeCache();
    campaignRepository.createCampaign(GUILD, 'Tavolo');
});

afterAll(() => { delete process.env.SECRETS_MASTER_KEY; });

function putKey(secretKey: string, value = 'sk-qualcosa') {
    tenantSecretsRepository.put({ scope: 'guild', scopeId: GUILD, secretKey }, value);
}

/**
 * Gives the table a transcription engine.
 *
 * `ready` always requires one: without it, a recording is audio nobody
 * will be able to read. The cases here that check the *phase keys* therefore have
 * to have it, or they would fail for the wrong reason.
 */
function withTranscription(settings: Record<string, unknown> = {}) {
    tenantAiSettingsRepository.put('guild', GUILD, {
        ...settings,
        transcription: { engine: 'remote', remote: { url: 'http://pc-del-tavolo:3001' } },
    });
}

describe('checkAiReadiness', () => {
    it('reports a table with no keys at all as not ready', () => {
        const readiness = checkAiReadiness({ guildId: GUILD });

        expect(readiness.ready).toBe(false);
        expect(readiness.missing.length).toBeGreaterThan(0);
        // The providers are stated once: the user needs to know which
        // keys to get, not the list of the nine internal phases.
        expect(readiness.providers).toEqual([...new Set(readiness.providers)]);
    });

    it('nomina la credenziale esatta da configurare', () => {
        const readiness = checkAiReadiness({ guildId: GUILD }, ['analyst']);

        expect(readiness.missing).toHaveLength(1);
        expect(readiness.missing[0].phase).toBe('analyst');
        expect(readiness.missing[0].secretKey).toMatch(/\.apiKey$/);
    });

    it('is ready once the table has the key for that phase', () => {
        withTranscription({ tiers: { quality: { provider: 'openai', model: 'un-modello' } } });
        putKey('openai.apiKey');

        expect(checkAiReadiness({ guildId: GUILD }, ['analyst', 'summary']).ready).toBe(true);
    });

    it('one provider key does not cover the phases that use another', () => {
        // The real case: OpenAI is configured and the Fast group is left on
        // Gemini. Saying "ready" here would mean starting a session
        // that will stop halfway through the pipeline.
        tenantAiSettingsRepository.put('guild', GUILD, {
            tiers: {
                quality: { provider: 'openai', model: 'pro' },
                fast: { provider: 'gemini', model: 'flash' },
            },
        });
        putKey('openai.apiKey');

        const readiness = checkAiReadiness({ guildId: GUILD }, ['analyst', 'metadata']);
        expect(readiness.ready).toBe(false);
        expect(readiness.providers).toEqual(['gemini']);
    });

    it('treats local Ollama as ready, since it has no keys to configure', () => {
        // It runs on the table's own hardware: there is nothing to get. Whether the
        // node answers is another question, and a key does not solve it.
        withTranscription({ tiers: { quality: { provider: 'ollama', model: 'un-modello-locale' } } });

        expect(checkAiReadiness({ guildId: GUILD }, ['analyst']).ready).toBe(true);
    });

    it('with no transcription engine it is not ready, however many keys it has', () => {
        // It is the hard prerequisite: the other phases degrade, this one does not. A
        // session started without transcription is lost, not postponed.
        tenantAiSettingsRepository.put('guild', GUILD, {
            tiers: { quality: { provider: 'openai', model: 'un-modello' } },
        });
        putKey('openai.apiKey');

        const readiness = checkAiReadiness({ guildId: GUILD }, ['analyst']);
        expect(readiness.missing).toEqual([]);
        expect(readiness.canTranscribe).toBe(false);
        expect(readiness.ready).toBe(false);
    });

    it('the table\'s own PC is enough: no key to obtain in order to transcribe', () => {
        withTranscription();
        expect(checkAiReadiness({ guildId: GUILD }, []).canTranscribe).toBe(true);
    });

    it('the cloud path requires the key of the provider doing the transcription', () => {
        tenantAiSettingsRepository.put('guild', GUILD, {
            transcription: { engine: 'cloud', cloud: { provider: 'openai', model: 'gpt-4o-mini-transcribe' } },
        });
        expect(checkAiReadiness({ guildId: GUILD }, []).canTranscribe).toBe(false);

        putKey('openai.apiKey');
        expect(checkAiReadiness({ guildId: GUILD }, []).canTranscribe).toBe(true);
    });
});
