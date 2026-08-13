// No real Redis in the test environment: the same in-memory fake as the others.
jest.mock('ioredis', () => {
    const store = new Map<string, string>();
    return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        set: jest.fn(async (key: string, value: string) => {
            store.set(key, value);
            return 'OK';
        }),
        del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
        ttl: jest.fn(async (key: string) => (store.has(key) ? 3600 : -2)),
    }));
});

// The probe would talk to the real provider: what matters here is how we classify
// its outcome, not OpenAI's answer.
const probeMock = jest.fn();
jest.mock('../../../src/bard/ai/providerFactory', () => ({
    ...jest.requireActual('../../../src/bard/ai/providerFactory'),
    probeProviderCredentials: (...args: unknown[]) => probeMock(...args),
}));

import http from 'http';
import type { AddressInfo } from 'net';
import { createNestApp } from '../../../src/api/main';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { tenantSecretsRepository } from '../../../src/db/repositories/TenantSecretsRepository';
import { tenantAiSettingsRepository } from '../../../src/db/repositories/TenantAiSettingsRepository';
import { ensureMembership } from '../../../src/services/campaignAccess';
import { db } from '../../../src/db';
import { WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';

const GUILD = 'ai-settings-guild';
const ADMIN = 'user-ai-admin';
const MEMBER = 'user-ai-member';
const MASTER_KEY = Buffer.alloc(32, 11).toString('base64');

function fakeSession(userId: string, canManage: boolean): WebSessionData {
    return {
        discordUserId: userId,
        username: 'tester',
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [{ id: GUILD, name: 'AI Table', icon: null, canManage }],
        guildsFetchedAt: Date.now(),
    };
}

/**
 * A table's AI settings.
 *
 * The value of these tests is not the CRUD but the boundaries: that the key never
 * leaves through any route, that only a server administrator can write, and
 * that a provider error becomes the right state — because confusing
 * "out of credit" with "invalid key" sends the user off to regenerate a
 * perfectly good key instead of topping up.
 */
describe('The table\'s AI settings (web)', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let adminCookie: string;
    let memberCookie: string;

    beforeAll(async () => {
        process.env.SECRETS_MASTER_KEY = MASTER_KEY;
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD, 'AI Campaign');

        adminCookie = 'ai-admin-session';
        await signIn(adminCookie, fakeSession(ADMIN, true));
        ensureMembership(campaignId, ADMIN, 'MASTER');

        memberCookie = 'ai-member-session';
        await signIn(memberCookie, fakeSession(MEMBER, false));
        ensureMembership(campaignId, MEMBER);
    });

    afterAll(async () => {
        await app.close();
        db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
        db.prepare('DELETE FROM tenant_secrets WHERE scope_id = ?').run(GUILD);
        db.prepare('DELETE FROM tenant_ai_settings WHERE scope_id = ?').run(GUILD);
        delete process.env.SECRETS_MASTER_KEY;
    });

    beforeEach(() => {
        probeMock.mockReset();
        db.prepare('DELETE FROM tenant_secrets WHERE scope_id = ?').run(GUILD);
        db.prepare('DELETE FROM tenant_ai_settings WHERE scope_id = ?').run(GUILD);
    });

    const base = `/api/v1/guilds/${GUILD}/ai-settings`;

    function get(url: string, cookie = adminCookie) {
        return fastify.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
    }

    function mutate(
        method: 'PUT' | 'POST' | 'DELETE',
        url: string,
        payload?: Record<string, unknown>,
        cookie = adminCookie,
    ) {
        return fastify.inject({
            method,
            url,
            headers: {
                cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
                ...(payload ? { 'content-type': 'application/json' } : {}),
            },
            ...(payload ? { payload: JSON.stringify(payload) } : {}),
        });
    }

    describe('lettura', () => {
        it('says the table is not ready until it has keys', async () => {
            const response = await get(base);

            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body.ready).toBe(false);
            expect(body.missing_providers.length).toBeGreaterThan(0);
            expect(body.credentials.every((c: any) => c.configured === false)).toBe(true);
        });

        it('expands the two groups across every phase', async () => {
            const body = JSON.parse((await get(base)).payload);

            const analyst = body.effective.find((p: any) => p.phase === 'analyst');
            const metadata = body.effective.find((p: any) => p.phase === 'metadata');
            expect(analyst.tier).toBe('quality');
            expect(metadata.tier).toBe('fast');
            // Embedding and transcription stay outside the groups: they have model
            // families of their own and a dedicated selection.
            expect(body.effective.find((p: any) => p.phase === 'embedding').tier).toBeNull();
        });

        it('an ordinary member, who does not administer, can read it too', async () => {
            expect((await get(base, memberCookie)).statusCode).toBe(200);
        });
    });

    describe('what the effective table says about indexing', () => {
        it('names the model the table would really index with, not the file default', async () => {
            // The generic per-phase resolver reads ai.config.json and always
            // answered «Ollama · nomic-embed-text» — free, on your own hardware.
            // Embedding does not come from there: with no machine of its own,
            // a table falls back to the cloud model of the key it has, and this
            // one is billed to Gemini.
            await mutate('PUT', `${base}/credentials/gemini`, { api_key: 'AIza-per-indicizzare' });
            await mutate('PUT', `${base}/transcription`, { engine: 'cloud', cloud_model: 'gemini-3.6-flash' });

            const body = JSON.parse((await get(base)).payload);
            const embedding = body.effective.find((p: any) => p.phase === 'embedding');

            expect(embedding.provider).toBe('gemini');
            expect(embedding.model).toBe('gemini-embedding-001');
        });

        it('says Ollama when the table does have a machine of its own', async () => {
            // The Ollama node lives on the same host as the transcription PC:
            // with one configured, indexing really is free and local.
            await mutate('PUT', `${base}/credentials/gemini`, { api_key: 'AIza-comunque' });
            await mutate('PUT', `${base}/transcription`, {
                engine: 'remote', remote_url: 'http://100.64.0.1:3001',
            });

            const body = JSON.parse((await get(base)).payload);
            const embedding = body.effective.find((p: any) => p.phase === 'embedding');

            expect(embedding.provider).toBe('ollama');
            expect(embedding.model).toBe('nomic-embed-text');
        });
    });

    describe('la chiave non esce mai', () => {
        it('no route returns the value, only the last few digits', async () => {
            const testCredential = ['unit', 'test', 'credential', '1234'].join('-');
            const stored = await mutate('PUT', `${base}/credentials/openai`, { api_key: testCredential });
            expect(stored.statusCode).toBe(204);
            expect(stored.payload).toBe('');

            const body = JSON.parse((await get(base)).payload);
            const openai = body.credentials.find((c: any) => c.provider === 'openai');

            expect(openai.configured).toBe(true);
            expect(openai.hint).toBe('1234');
            expect(JSON.stringify(body)).not.toContain(testCredential);
        });

        it('stores it encrypted: the plaintext is not in the database', () => {
            tenantSecretsRepository.put(
                { scope: 'guild', scopeId: GUILD, secretKey: 'openai.apiKey' },
                'sk-in-chiaro-mai',
            );
            const row = db.prepare(
                'SELECT ciphertext FROM tenant_secrets WHERE scope_id = ? AND secret_key = ?',
            ).get(GUILD, 'openai.apiKey') as { ciphertext: Buffer };

            expect(row.ciphertext.toString('utf8')).not.toContain('sk-in-chiaro-mai');
        });
    });

    describe('who may write', () => {
        it('a member without management permissions cannot save keys', async () => {
            const response = await mutate(
                'PUT', `${base}/credentials/openai`, { api_key: 'sk-di-un-giocatore' }, memberCookie,
            );
            expect(response.statusCode).toBe(403);
        });

        it('a member without management permissions cannot change the models', async () => {
            const response = await mutate(
                'PUT', base, { quality: { provider: 'openai', model: 'x' } }, memberCookie,
            );
            expect(response.statusCode).toBe(403);
        });
    });

    /**
     * Both keys in the vault.
     *
     * Choosing a model on a provider the table has no key for is refused, so a
     * test about *saving a choice* has to start from a table that could actually
     * make it. The `beforeEach` above wipes the secrets on purpose — the tests
     * about the absence of a key need that — so the seeding is local.
     */
    function seedBothKeys() {
        tenantSecretsRepository.put({ scope: 'guild', scopeId: GUILD, secretKey: 'openai.apiKey' }, 'sk-seed');
        tenantSecretsRepository.put({ scope: 'guild', scopeId: GUILD, secretKey: 'gemini.apiKey' }, 'AIza-seed');
    }

    describe('scelta dei modelli', () => {
        beforeEach(seedBothKeys);

        it('refuses a provider this table has no key for', async () => {
            db.prepare('DELETE FROM tenant_secrets WHERE scope_id = ?').run(GUILD);

            const response = await mutate('PUT', base, {
                quality: { provider: 'openai', model: 'un-modello-pro' },
            });

            // A configuration that looks saved and stops mid-session is worse
            // than a refusal at the moment of the choice.
            expect(response.statusCode).toBe(400);
            expect(response.payload).toContain('openai');
        });

        it('accepts ollama with no key at all: it is the table\'s own hardware', async () => {
            db.prepare('DELETE FROM tenant_secrets WHERE scope_id = ?').run(GUILD);

            const response = await mutate('PUT', base, {
                fast: { provider: 'ollama', model: 'qwen3:8b' },
            });

            expect(response.statusCode).toBe(200);
        });

        it('saves the two groups and applies them to the phases', async () => {
            const response = await mutate('PUT', base, {
                quality: { provider: 'openai', model: 'un-modello-pro' },
                fast: { provider: 'gemini', model: 'un-modello-flash' },
            });

            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body.effective.find((p: any) => p.phase === 'summary').model).toBe('un-modello-pro');
            expect(body.effective.find((p: any) => p.phase === 'chat').model).toBe('un-modello-flash');
        });

        it('does not wipe the per-phase overrides saved from the campaign advanced settings', async () => {
            // The groups PUT only touches the groups: the overrides live elsewhere
            // in the UI, and losing them to a save here would be
            // a change nobody asked for.
            tenantAiSettingsRepository.put('guild', GUILD, {
                phases: { summary: { provider: 'anthropic', model: 'override-writer' } },
            });

            await mutate('PUT', base, { quality: { provider: 'openai', model: 'gruppo' } });

            const body = JSON.parse((await get(base)).payload);
            expect(body.effective.find((p: any) => p.phase === 'summary').model).toBe('override-writer');
            expect(body.effective.find((p: any) => p.phase === 'analyst').model).toBe('gruppo');
        });

        it('null azzera la scelta e riporta ai default di istanza', async () => {
            await mutate('PUT', base, { quality: { provider: 'openai', model: 'temporaneo' } });
            const cleared = await mutate('PUT', base, { quality: null });

            const body = JSON.parse(cleared.payload);
            expect(body.quality).toBeNull();
            expect(body.effective.find((p: any) => p.phase === 'analyst').model).not.toBe('temporaneo');
        });

        it('rejects a made-up provider', async () => {
            const response = await mutate('PUT', base, { fast: { provider: 'inventato', model: 'x' } });
            expect(response.statusCode).toBe(400);
        });

        it('does not allow picking providers that would stop halfway through a session', async () => {
            for (const provider of ['anthropic', 'ollama-cloud']) {
                const response = await mutate('PUT', base, { quality: { provider, model: 'x' } });
                expect(response.statusCode).toBe(400);
            }
        });

        it('offers only the providers that cover the whole pipeline', async () => {
            const body = JSON.parse((await get(base)).payload);
            // Ollama appears among the selectable providers but not among the keys:
            // it is the table's hardware, not a credential.
            expect(body.credentials.map((c: any) => c.provider).sort()).toEqual(['gemini', 'openai']);
        });

        it('accetta un modello non in catalogo', async () => {
            // The catalogue is curated, not exhaustive, and providers publish
            // new models every month: rejecting a valid id because we do not
            // know it would be worse than the typo the provider reports.
            const response = await mutate('PUT', base, {
                fast: { provider: 'openai', model: 'gpt-uscito-domani' },
            });
            expect(response.statusCode).toBe(200);
        });
    });

    describe('testing the key', () => {
        beforeEach(async () => {
            await mutate('PUT', `${base}/credentials/openai`, { api_key: 'sk-da-provare-9999' });
        });

        it('records OK and shows it on the next read', async () => {
            probeMock.mockResolvedValue(undefined);

            const response = await mutate('POST', `${base}/credentials/openai/test`);
            expect(JSON.parse(response.payload).status).toBe('OK');

            const body = JSON.parse((await get(base)).payload);
            expect(body.credentials.find((c: any) => c.provider === 'openai').verify_status).toBe('OK');
        });

        it('tells an exhausted balance apart from an invalid key', async () => {
            // It is the distinction that matters to the user: a dry key is
            // valid, and telling them it is not sends them to regenerate it instead
            // of topping up.
            probeMock.mockRejectedValue(Object.assign(new Error('You exceeded your current quota'), {
                status: 429, code: 'insufficient_quota',
            }));

            const response = await mutate('POST', `${base}/credentials/openai/test`);
            expect(JSON.parse(response.payload).status).toBe('QUOTA_EXHAUSTED');
        });

        it('recognises a rejected key', async () => {
            probeMock.mockRejectedValue(Object.assign(new Error('Incorrect API key provided'), {
                status: 401, code: 'invalid_api_key',
            }));

            const response = await mutate('POST', `${base}/credentials/openai/test`);
            expect(JSON.parse(response.payload).status).toBe('AUTH_FAILED');
        });

        it('does not leak the key in the error detail', async () => {
            probeMock.mockRejectedValue(new Error('Incorrect API key provided: sk-da-provare-9999'));

            const response = await mutate('POST', `${base}/credentials/openai/test`);
            expect(response.payload).not.toContain('sk-da-provare-9999');
        });
    });

    describe('rimozione', () => {
        it('deletes the key and the table goes back to unconfigured', async () => {
            await mutate('PUT', `${base}/credentials/openai`, { api_key: 'sk-da-cancellare' });
            const removed = await mutate('DELETE', `${base}/credentials/openai`);
            expect(removed.statusCode).toBe(204);

            const body = JSON.parse((await get(base)).payload);
            expect(body.credentials.find((c: any) => c.provider === 'openai').configured).toBe(false);
        });

        it('rejects a key for local Ollama, which has none', async () => {
            const response = await mutate('PUT', `${base}/credentials/ollama`, { api_key: 'irrilevante' });
            expect(response.statusCode).toBe(400);
        });

        it('rejects a key for a provider that does not complete the pipeline', async () => {
            // Anthropic does not transcribe and has no embedding models: keeping
            // its key would mean storing a credential that will never
            // be able to carry a session through to the end.
            for (const provider of ['anthropic', 'ollama-cloud']) {
                const response = await mutate('PUT', `${base}/credentials/${provider}`, { api_key: 'sk-x' });
                expect(response.statusCode).toBe(400);
            }
        });
    });

    describe('vista di campagna', () => {
        it('shows the master what will be used, without giving access to the keys', async () => {
            const response = await get(`/api/v1/campaigns/${campaignId}/ai-settings/effective`, memberCookie);

            expect(response.statusCode).toBe(200);
            const body = JSON.parse(response.payload);
            expect(body.guild_id).toBe(GUILD);
            expect(body.effective.length).toBeGreaterThan(0);
            // Someone who does not administer the server sees it, but cannot change it.
            expect(body.can_manage).toBe(false);
            expect(JSON.stringify(body)).not.toContain('apiKey');
        });
    });

    describe('avanzate di campagna', () => {
        // A function, not a constant: `campaignId` is assigned in beforeAll,
        // after the describe body has already been evaluated.
        const phasesUrl = () => `/api/v1/campaigns/${campaignId}/ai-settings/phases`;

        // The key check on an override is the guild's, because the key is.
        beforeEach(seedBothKeys);

        it('the campaign override beats the guild\'s group', async () => {
            await mutate('PUT', base, { quality: { provider: 'openai', model: 'gruppo-qualita' } });

            const saved = await mutate('PUT', phasesUrl(), {
                overrides: [{ phase: 'summary', provider: 'gemini', model: 'solo-per-questa-campagna' }],
            });
            expect(saved.statusCode).toBe(200);

            const view = JSON.parse((await get(`/api/v1/campaigns/${campaignId}/ai-settings/effective`)).payload);
            expect(view.effective.find((p: any) => p.phase === 'summary').model)
                .toBe('solo-per-questa-campagna');
            // The other phase of the same group is untouched.
            expect(view.effective.find((p: any) => p.phase === 'analyst').model).toBe('gruppo-qualita');
        });

        it('refuses to override the embedding model, and says where it is changed', async () => {
            // Nothing reads `phases.embedding`: embedding resolves from the model
            // pinned to the campaign. Accepting it would have written a setting
            // that changes nothing while making the effective table announce a
            // model that never runs.
            const response = await mutate('PUT', phasesUrl(), {
                overrides: [{ phase: 'embedding', provider: 'gemini', model: 'gemini-3.1-pro-preview' }],
            });

            expect(response.statusCode).toBe(400);
            expect(response.payload).toMatch(/reindex/i);
        });

        it('hides a legacy embedding override instead of serving it back', async () => {
            // Written before the row was removed. Filtering it on read is what
            // lets it heal: the page never shows it, so the next save — which
            // replaces the set wholesale — drops it from storage.
            tenantAiSettingsRepository.put('campaign', String(campaignId), {
                phases: {
                    embedding: { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
                    summary: { provider: 'gemini', model: 'un-modello' },
                },
            }, ADMIN);

            const view = JSON.parse((await get(`/api/v1/campaigns/${campaignId}/ai-settings/effective`)).payload);
            expect(view.overrides.map((o: any) => o.phase)).toEqual(['summary']);
        });

        it('does not touch the other campaigns of the same guild', async () => {
            const other = campaignRepository.createCampaign(GUILD, 'Altra campagna');
            await mutate('PUT', base, { quality: { provider: 'openai', model: 'gruppo' } });
            await mutate('PUT', phasesUrl(), {
                overrides: [{ phase: 'summary', provider: 'gemini', model: 'solo-la-prima' }],
            });

            const view = JSON.parse((await get(`/api/v1/campaigns/${other}/ai-settings/effective`)).payload);
            expect(view.effective.find((p: any) => p.phase === 'summary').model).toBe('gruppo');

            db.prepare('DELETE FROM campaigns WHERE id = ?').run(other);
            db.prepare('DELETE FROM tenant_ai_settings WHERE scope = ? AND scope_id = ?').run('campaign', String(other));
        });

        it('an empty array clears them all', async () => {
            await mutate('PUT', phasesUrl(), {
                overrides: [{ phase: 'summary', provider: 'gemini', model: 'temporaneo' }],
            });
            const cleared = await mutate('PUT', phasesUrl(), { overrides: [] });

            expect(JSON.parse(cleared.payload)).toEqual([]);
        });

        it('rejects a made-up phase', async () => {
            const response = await mutate('PUT', phasesUrl(), {
                overrides: [{ phase: 'fase-che-non-esiste', provider: 'openai', model: 'x' }],
            });
            expect(response.statusCode).toBe(400);
        });

        it('does not switch the summary pipeline off while saving a model', async () => {
            const flowUrl = `/api/v1/campaigns/${campaignId}/ai-settings/flow`;
            await mutate('PUT', flowUrl, { agentic_summary: true });

            await mutate('PUT', phasesUrl(), {
                overrides: [{ phase: 'summary', provider: 'gemini', model: 'un-modello' }],
            });

            // Saving the phases used to replace the whole settings object, so
            // choosing a model for one phase quietly turned the agentic summary
            // back off — a setting the table had paid attention to, undone by an
            // unrelated action.
            const view = JSON.parse((await get(`/api/v1/campaigns/${campaignId}/ai-settings/effective`)).payload);
            expect(view.agentic_summary).toBe(true);
        });

        afterEach(() => {
            db.prepare('DELETE FROM tenant_ai_settings WHERE scope = ?').run('campaign');
        });
    });

    describe('stima di costo di una fase', () => {
        const estimateUrl = (query: string) =>
            `/api/v1/campaigns/${campaignId}/ai-settings/phase-estimate?${query}`;

        it('prices a candidate model on a typical session', async () => {
            const body = JSON.parse((await get(
                estimateUrl('phase=summary&provider=openai&model=gpt-5.4-nano'),
            )).payload);

            expect(body.phase).toBe('summary');
            expect(body.model).toBe('gpt-5.4-nano');
            // Four hours: what a session usually is, when nobody says otherwise.
            expect(body.audio_minutes).toBe(240);
            expect(body.input_tokens).toBeGreaterThan(0);
            expect(body.cost_usd).toBeGreaterThan(0);
            expect(body.pricing_source).toBe('builtin');
            // No history on a fresh table: the figure comes from our constants,
            // and the UI has to be able to say so.
            expect(body.calibrated).toBe(false);
        });

        it('makes a cheaper model visibly cheaper', async () => {
            const dear = JSON.parse((await get(
                estimateUrl('phase=summary&provider=openai&model=gpt-5.6-sol'),
            )).payload);
            const cheap = JSON.parse((await get(
                estimateUrl('phase=summary&provider=openai&model=gpt-5.4-nano'),
            )).payload);

            // The whole reason the figure sits next to the select: seeing that
            // one option costs a fraction of the other, before choosing.
            expect(cheap.cost_usd).toBeLessThan(dear.cost_usd);
        });

        it('reports an unknown rate as no price, never as free', async () => {
            const body = JSON.parse((await get(
                estimateUrl('phase=summary&provider=openai&model=un-modello-mai-visto'),
            )).payload);

            expect(body.pricing_source).toBe('unknown');
            expect(body.cost_usd).toBeNull();
            expect(body.cost_eur).toBeNull();
            // The tokens are still known: it is the rate we lack, not the volume.
            expect(body.input_tokens).toBeGreaterThan(0);
        });

        it('says zero for the table\'s own hardware, and that it costs something else', async () => {
            const body = JSON.parse((await get(
                estimateUrl('phase=summary&provider=ollama&model=qwen3:8b'),
            )).payload);

            expect(body.cost_usd).toBe(0);
            expect(body.pricing_source).toBe('free');
            expect(body.runs_on_your_hardware).toBe(true);
        });

        it('scales its input with the length of the session, but not its output', async () => {
            // `summary` writes one recap per session: its length answers to what
            // happened, not to how long the table talked about it. Only the input
            // side — re-reading a longer transcript — grows with the minutes.
            const short = JSON.parse((await get(
                estimateUrl('phase=summary&provider=openai&model=gpt-5.4-nano&minutes=60'),
            )).payload);
            const long = JSON.parse((await get(
                estimateUrl('phase=summary&provider=openai&model=gpt-5.4-nano&minutes=240'),
            )).payload);

            expect(long.input_tokens).toBeCloseTo(short.input_tokens * 4, 6);
            expect(long.output_tokens).toBe(short.output_tokens);
        });

        it('refuses a phase or a provider that does not exist', async () => {
            expect((await get(estimateUrl('phase=inventata&provider=openai&model=x'))).statusCode).toBe(400);
            expect((await get(estimateUrl('phase=summary&provider=inventato&model=x'))).statusCode).toBe(400);
            expect((await get(estimateUrl('phase=summary&provider=openai&model='))).statusCode).toBe(400);
        });

        it('does not let a query string ask for a year of audio', async () => {
            const body = JSON.parse((await get(
                estimateUrl('phase=summary&provider=openai&model=gpt-5.4-nano&minutes=999999'),
            )).payload);
            expect(body.audio_minutes).toBe(24 * 60);
        });
    });

    describe('trascrizione di campagna', () => {
        const campaignUrl = () => `/api/v1/campaigns/${campaignId}/ai-settings/transcription`;
        const guildUrl = `${base}/transcription`;

        afterEach(() => {
            db.prepare('DELETE FROM tenant_ai_settings WHERE scope = ?').run('campaign');
        });

        it('follows the guild until the campaign says otherwise', async () => {
            await mutate('PUT', guildUrl, {
                engine: 'cloud', cloud_model: 'gpt-4o-mini-transcribe',
            });

            const before = JSON.parse((await get(campaignUrl())).payload);
            expect(before.cloud_model).toBeNull();
            expect(before.effective_model).toBe('gpt-4o-mini-transcribe');

            const saved = await mutate('PUT', campaignUrl(), { cloud_model: 'gpt-4o-transcribe' });
            const after = JSON.parse(saved.payload);
            expect(after.cloud_model).toBe('gpt-4o-transcribe');
            expect(after.effective_model).toBe('gpt-4o-transcribe');
            // The more accurate model costs twice as much, and that has to be
            // visible where it is chosen.
            expect(after.usd_per_minute).toBe(0.006);
        });

        it('clearing the choice goes back to following the guild', async () => {
            await mutate('PUT', guildUrl, { engine: 'cloud', cloud_model: 'gpt-4o-mini-transcribe' });
            await mutate('PUT', campaignUrl(), { cloud_model: 'gpt-4o-transcribe' });

            const cleared = JSON.parse((await mutate('PUT', campaignUrl(), { cloud_model: null })).payload);
            expect(cleared.cloud_model).toBeNull();
            expect(cleared.effective_model).toBe('gpt-4o-mini-transcribe');
        });

        it('infers the provider from the model, so one key keeps covering the flow', async () => {
            await mutate('PUT', `${base}/credentials/gemini`, { api_key: 'AIza-chiave' });
            await mutate('PUT', guildUrl, { engine: 'cloud', cloud_model: 'gpt-4o-mini-transcribe' });

            const saved = JSON.parse(
                (await mutate('PUT', campaignUrl(), { cloud_model: 'gemini-3.6-flash' })).payload,
            );
            expect(saved.effective_provider).toBe('gemini');
        });

        it('moves which model, never who pays or whose machine', async () => {
            await mutate('PUT', guildUrl, {
                engine: 'remote', remote_url: 'http://100.64.0.1:3001', remote_model: 'large-v3',
            });
            await mutate('PUT', campaignUrl(), { remote_model: 'distil-large-v3' });

            const campaign = JSON.parse((await get(campaignUrl())).payload);
            expect(campaign.effective_model).toBe('distil-large-v3');

            // The guild keeps its own model, its PC and its engine: a campaign
            // cannot redirect the work onto another machine or another payer.
            const guild = JSON.parse((await get(guildUrl)).payload);
            expect(guild.remote.model).toBe('large-v3');
            expect(guild.remote.url).toBe('http://100.64.0.1:3001');
            expect(campaign.engine).toBe('remote');
        });

        it('cannot change the engine, which is who pays', async () => {
            await mutate('PUT', guildUrl, { engine: 'remote', remote_url: 'http://100.64.0.1:3001' });

            // The field simply does not exist in the body: an attempt to switch
            // the table onto a paid route is ignored, not obeyed.
            await mutate('PUT', campaignUrl(), { engine: 'cloud', cloud_model: 'whisper-1' } as any);

            expect(JSON.parse((await get(campaignUrl())).payload).engine).toBe('remote');
        });

        it('does not touch the other campaigns of the same guild', async () => {
            const other = campaignRepository.createCampaign(GUILD, 'Altro tavolo');
            await mutate('PUT', guildUrl, { engine: 'cloud', cloud_model: 'gpt-4o-mini-transcribe' });
            await mutate('PUT', campaignUrl(), { cloud_model: 'gpt-4o-transcribe' });

            const view = JSON.parse(
                (await get(`/api/v1/campaigns/${other}/ai-settings/transcription`)).payload,
            );
            expect(view.effective_model).toBe('gpt-4o-mini-transcribe');

            db.prepare('DELETE FROM campaigns WHERE id = ?').run(other);
            db.prepare('DELETE FROM tenant_ai_settings WHERE scope = ? AND scope_id = ?')
                .run('campaign', String(other));
        });
    });

    describe('trascrizione', () => {
        const url = `${base}/transcription`;

        it('a brand new table cannot transcribe', async () => {
            const body = JSON.parse((await get(url)).payload);
            expect(body.engine).toBeNull();
            expect(body.usable).toBe(false);
            expect(body.reason).toBe('NOT_CONFIGURED');
        });

        it('the table\'s own PC is enough by itself, with no keys', async () => {
            const saved = await mutate('PUT', url, {
                engine: 'remote', remote_url: 'http://100.64.0.1:3001/',
            });

            const body = JSON.parse(saved.payload);
            expect(body.usable).toBe(true);
            // The trailing slash is normalized: the bot appends /health and
            // /transcribe to it, and a double slash is a 404 nobody understands.
            expect(body.remote.url).toBe('http://100.64.0.1:3001');
            expect(body.cloud_usd_per_minute).toBeNull();
        });

        it('remembers which of the PC\'s models to use, and lets the PC decide by default', async () => {
            const byDefault = await mutate('PUT', url, {
                engine: 'remote', remote_url: 'http://100.64.0.1:3001',
            });
            // No choice: the PC keeps using whatever its own WHISPER_MODEL says,
            // which is how every install behaved before there was a choice.
            expect(JSON.parse(byDefault.payload).remote.model).toBeNull();

            const chosen = await mutate('PUT', url, { remote_model: 'large-v3' });
            expect(JSON.parse(chosen.payload).remote.model).toBe('large-v3');

            const cleared = await mutate('PUT', url, { remote_model: null });
            expect(JSON.parse(cleared.payload).remote.model).toBeNull();
        });

        it('does not refuse a model just because the PC is asleep', async () => {
            await mutate('PUT', url, { engine: 'remote', remote_url: 'http://100.64.0.1:3001' });

            // The machine is unreachable here, and that must not stop someone
            // preparing for tonight's session from saving the choice.
            const saved = await mutate('PUT', url, { remote_model: 'distil-large-v3' });
            expect(saved.statusCode).toBe(200);
            expect(JSON.parse(saved.payload).remote.model).toBe('distil-large-v3');
        });

        it('says why it cannot list the PC\'s models instead of failing', async () => {
            await mutate('PUT', url, { engine: 'cloud', cloud_model: 'whisper-1' });
            const onCloud = JSON.parse((await get(`${url}/models`)).payload);
            expect(onCloud).toEqual({ models: [], current: null, reason: 'NOT_REMOTE' });

            await mutate('PUT', url, { engine: 'remote', remote_url: 'http://127.0.0.1:9/' });
            const offline = JSON.parse((await get(`${url}/models`)).payload);
            expect(offline.reason).toBe('UNREACHABLE');
            expect(offline.models).toEqual([]);
        });

        it('the cloud path requires the key of the provider doing the transcription', async () => {
            const withoutKey = await mutate('PUT', url, {
                engine: 'cloud', cloud_provider: 'openai', cloud_model: 'gpt-4o-mini-transcribe',
            });
            expect(JSON.parse(withoutKey.payload).reason).toBe('NO_CLOUD_KEY');

            await mutate('PUT', `${base}/credentials/openai`, { api_key: 'sk-per-trascrivere' });
            const body = JSON.parse((await get(url)).payload);
            expect(body.usable).toBe(true);
            // The price is known before recording, not after the fact.
            expect(body.cloud_usd_per_minute).toBe(0.003);
        });

        it('with Gemini a single key covers the whole flow', async () => {
            // It is the reason the Gemini path exists: without it, a table
            // that chose Gemini would have to open an OpenAI account just to
            // turn audio into text.
            await mutate('PUT', `${base}/credentials/gemini`, { api_key: 'AIza-una-sola-chiave' });
            const saved = await mutate('PUT', url, {
                engine: 'cloud', cloud_provider: 'gemini', cloud_model: 'gemini-3.6-flash',
            });

            expect(JSON.parse(saved.payload).usable).toBe(true);
        });

        it('rejects an address that is not http', async () => {
            // file:// would open file-reading paths on the server; a table's PC
            // needs nothing that is not HTTP.
            const response = await mutate('PUT', url, { engine: 'remote', remote_url: 'file:///etc/passwd' });
            expect(response.statusCode).toBe(400);
        });

        it('accepts private and Tailscale addresses, which are the normal case', async () => {
            for (const address of ['http://192.168.1.50:3001', 'http://pc.tail1234.ts.net:3001']) {
                const response = await mutate('PUT', url, { engine: 'remote', remote_url: address });
                expect(response.statusCode).toBe(200);
            }
        });

        it('the PC\'s token never comes back out', async () => {
            const stored = await mutate('PUT', `${url}/auth-token`, { value: 'token-del-mio-pc' });
            expect(stored.statusCode).toBe(204);

            const body = JSON.parse((await get(url)).payload);
            expect(body.remote.auth_token_configured).toBe(true);
            expect(JSON.stringify(body)).not.toContain('token-del-mio-pc');
        });

        it('exposes the wake methods with the fields each one asks for', async () => {
            const methods = JSON.parse((await get(`${base}/wake-methods`)).payload);

            const iliadbox = methods.find((m: any) => m.id === 'iliadbox');
            expect(methods.some((m: any) => m.id === 'udp')).toBe(true);
            // The router password is declared as a secret: it goes into the vault,
            // not into the settings in clear.
            expect(iliadbox.fields.find((f: any) => f.name === 'password').secret).toBe(true);
        });

        it('saves a wake-method secret without returning it', async () => {
            await mutate('PUT', url, {
                engine: 'remote',
                remote_url: 'http://pc:3001',
                wake: { mac_address: 'AA:BB:CC:DD:EE:FF', method: 'iliadbox', options: { iliadboxUrl: 'https://192.168.1.254' } },
            });
            const stored = await mutate('PUT', `${base}/wake-secrets/iliadbox/password`, { value: 'password-del-router' });
            expect(stored.statusCode).toBe(204);

            const body = JSON.parse((await get(url)).payload);
            expect(body.remote.wake.configured_secrets).toContain('password');
            expect(JSON.stringify(body)).not.toContain('password-del-router');
        });

        it('rejects a field the method does not declare', async () => {
            const response = await mutate('PUT', `${base}/wake-secrets/udp/password`, { value: 'x' });
            expect(response.statusCode).toBe(400);
        });

        it('rejects a wake method that does not exist', async () => {
            const response = await mutate('PUT', url, {
                engine: 'remote', remote_url: 'http://pc:3001', wake: { method: 'router-inventato' },
            });
            expect(response.statusCode).toBe(400);
        });
    });

    describe('the state of the table\'s own machine', () => {
        const url = `${base}/transcription`;

        /** A stand-in for lesta-penna-ai-server, answering only what is asked of it. */
        async function fakeMachine(routes: Record<string, { code: number; body?: unknown }>) {
            const server = http.createServer((request, response) => {
                const route = routes[request.url ?? ''];
                if (!route) {
                    response.writeHead(404).end();
                    return;
                }
                response.writeHead(route.code, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(route.body ?? {}));
            });
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const port = (server.address() as AddressInfo).port;
            return {
                origin: `http://127.0.0.1:${port}`,
                close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
            };
        }

        it('reports the accelerator, the loaded model and the uptime', async () => {
            // The probe already called /health and threw the body away: «on» and
            // «on, running the model you chose, since this afternoon» are not
            // the same answer to somebody checking before a session.
            const machine = await fakeMachine({
                '/health': {
                    code: 200,
                    body: {
                        status: 'ok',
                        hardware: { cpu: 'Ryzen 7', cpuCores: 16, totalMemory: '32GB', freeMemory: '20GB' },
                        whisper: { gpu: true, model: 'large-v3', accelerator: 'RTX 5060 TI (CUDA)' },
                        process: { uptime: '4200s' },
                    },
                },
            });
            await mutate('PUT', url, { engine: 'remote', remote_url: machine.origin });

            const body = JSON.parse((await get(`${url}/status`)).payload);
            expect(body.status).toBe('OK');
            expect(body.health).toMatchObject({
                gpu: true,
                accelerator: 'RTX 5060 TI (CUDA)',
                model: 'large-v3',
                cpu_cores: 16,
                uptime_seconds: 4200,
            });
            expect(body.checked_at).toBeGreaterThan(0);

            await machine.close();
        });

        it('says «we do not know» for what an older machine does not report', async () => {
            // The table owns that computer and may not have updated it. A
            // missing figure is null, never an invented default.
            const machine = await fakeMachine({ '/health': { code: 200, body: { status: 'ok' } } });
            await mutate('PUT', url, { engine: 'remote', remote_url: machine.origin });

            const body = JSON.parse((await get(`${url}/status`)).payload);
            expect(body.status).toBe('OK');
            expect(body.health).toEqual({
                gpu: null, accelerator: null, model: null, cpu: null,
                cpu_cores: null, total_memory: null, free_memory: null, uptime_seconds: null,
            });

            await machine.close();
        });

        it('a switched-off machine is a state, not an error', async () => {
            await mutate('PUT', url, { engine: 'remote', remote_url: 'http://127.0.0.1:9' });

            const response = await get(`${url}/status`);
            expect(response.statusCode).toBe(200);
            expect(JSON.parse(response.payload)).toMatchObject({ status: 'UNREACHABLE', health: null });
        });

        it('distinguishes a refused token from a machine that is off', async () => {
            const machine = await fakeMachine({ '/health': { code: 401 } });
            await mutate('PUT', url, { engine: 'remote', remote_url: machine.origin });

            expect(JSON.parse((await get(`${url}/status`)).payload).status).toBe('UNAUTHORIZED');

            await machine.close();
        });

        it('waking returns as soon as the request has left, not when the PC is up', async () => {
            // A boot takes minutes; a request held open that long dies to a
            // proxy timeout and leaves the page unable to say what happened.
            await mutate('PUT', url, {
                engine: 'remote',
                remote_url: 'http://127.0.0.1:9',
                wake: { mac_address: 'AA:BB:CC:DD:EE:FF', method: 'udp', options: { targetHost: '127.0.0.1' } },
            });

            const response = await mutate('POST', `${url}/wake`);
            expect(response.statusCode).toBe(202);
            const body = JSON.parse(response.payload);
            expect(body.status).toBe('WAKING');
            expect(body.boot_timeout_ms).toBeGreaterThan(0);
        });

        it('refuses to wake a table that has no MAC to wake', async () => {
            await mutate('PUT', url, { engine: 'remote', remote_url: 'http://127.0.0.1:9' });

            const body = JSON.parse((await mutate('POST', `${url}/wake`)).payload);
            expect(body.status).toBe('NOT_CONFIGURED');
        });
    });

    describe('shutting the machine down by hand', () => {
        const url = `${base}/transcription`;

        it('refuses when the table did not opt in', async () => {
            await mutate('PUT', url, { engine: 'remote', remote_url: 'http://127.0.0.1:9' });

            // Switching off somebody's home computer is an effect that has to be
            // asked for, not inferred — same rule as the automatic one.
            const body = JSON.parse((await mutate('POST', `${url}/shutdown`)).payload);
            expect(body.status).toBe('DISABLED');
        });

        it('refuses when no shutdown token is stored', async () => {
            await mutate('PUT', url, {
                engine: 'remote', remote_url: 'http://127.0.0.1:9', shutdown_enabled: true,
            });

            const body = JSON.parse((await mutate('POST', `${url}/shutdown`)).payload);
            expect(body.status).toBe('NO_TOKEN');
        });

        it('stores the shutdown token, and never gives it back', async () => {
            // Read from the vault since the post-session shutdown existed, and
            // writable from nowhere until this route: remote shutdown was, in
            // practice, unconfigurable from the web.
            const stored = await mutate('PUT', `${url}/shutdown-token`, { value: 'token-di-spegnimento' });
            expect(stored.statusCode).toBe(204);

            const body = JSON.parse((await get(url)).payload);
            expect(body.remote.shutdown_token_configured).toBe(true);
            expect(JSON.stringify(body)).not.toContain('token-di-spegnimento');
        });

        it('is a separate permission from reading: one token does not imply the other', async () => {
            await mutate('PUT', `${url}/auth-token`, { value: 'solo-lettura' });

            const body = JSON.parse((await get(url)).payload);
            expect(body.remote.auth_token_configured).toBe(true);
            expect(body.remote.shutdown_token_configured).toBe(false);
        });

        it('refuses an empty token instead of storing one', async () => {
            const response = await mutate('PUT', `${url}/shutdown-token`, { value: '   ' });
            expect(response.statusCode).toBe(400);
        });
    });

    describe('the recap flow', () => {
        const flowUrl = () => `/api/v1/campaigns/${campaignId}/ai-settings/flow`;

        it('it is the campaign\'s choice, not the guild\'s', async () => {
            const saved = await mutate('PUT', flowUrl(), { agentic_summary: true });
            expect(JSON.parse(saved.payload).agentic_summary).toBe(true);

            const view = JSON.parse((await get(`/api/v1/campaigns/${campaignId}/ai-settings/effective`)).payload);
            expect(view.agentic_summary).toBe(true);
        });

        it('two campaigns on the same server can choose differently', async () => {
            const other = campaignRepository.createCampaign(GUILD, 'One-shot');
            await mutate('PUT', flowUrl(), { agentic_summary: true });
            await mutate('PUT', `/api/v1/campaigns/${other}/ai-settings/flow`, { agentic_summary: false });

            const first = JSON.parse((await get(`/api/v1/campaigns/${campaignId}/ai-settings/effective`)).payload);
            const second = JSON.parse((await get(`/api/v1/campaigns/${other}/ai-settings/effective`)).payload);
            expect([first.agentic_summary, second.agentic_summary]).toEqual([true, false]);

            db.prepare('DELETE FROM campaigns WHERE id = ?').run(other);
            db.prepare('DELETE FROM tenant_ai_settings WHERE scope = ?').run('campaign');
        });

        afterEach(() => {
            db.prepare('DELETE FROM tenant_ai_settings WHERE scope = ?').run('campaign');
        });
    });

    describe('catalogo modelli', () => {
        it('propone modelli diversi per i due gruppi, col prezzo di listino', async () => {
            const body = JSON.parse((await get(`${base}/models?provider=openai`)).payload);

            expect(body.quality.length).toBeGreaterThan(0);
            expect(body.fast.length).toBeGreaterThan(0);
            expect(body.quality.some((m: any) => m.recommended)).toBe(true);
            // The price is seen at the moment of choosing, not only afterwards —
            // as figures the UI can lay out and compare, not spelled into the label.
            expect(body.fast[0].input_per_million).toBeGreaterThan(0);
            expect(body.fast[0].output_per_million).toBeGreaterThan(0);
        });

        it('declares zero cost for local Ollama', async () => {
            const body = JSON.parse((await get(`${base}/models?provider=ollama`)).payload);
            // Not a price of zero: a different kind of cost, which the UI has to
            // word differently — it still takes time and electricity.
            expect(body.quality[0].runs_on_your_hardware).toBe(true);
            expect(body.quality[0].input_per_million).toBeNull();
        });

        it('offers the transcription models, priced per minute of audio', async () => {
            const body = JSON.parse((await get(`${base}/models?provider=openai`)).payload);

            expect(body.transcription.length).toBeGreaterThan(0);
            // A different billing unit from everything else, and it must not be
            // reported in the per-token fields.
            expect(body.transcription[0].per_minute_usd).toBeGreaterThan(0);
            expect(body.transcription[0].input_per_million).toBeNull();
        });

        it('has no transcription models for a provider that cannot hear', async () => {
            const body = JSON.parse((await get(`${base}/models?provider=ollama`)).payload);
            expect(body.transcription).toEqual([]);
        });
    });
});
