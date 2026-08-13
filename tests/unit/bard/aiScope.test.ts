/**
 * Wiring the per-guild scope.
 *
 * It is the phase in which "which table pays" stops being implicit. Every case
 * here defends against a concrete way of getting the table wrong: deriving it from a legacy
 * session without `guild_id`, losing it across Redis, or not having it at all
 * and silently falling back on the operator's key.
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { tenantAiSettingsRepository } from '../../../src/db/repositories/TenantAiSettingsRepository';
import { db } from '../../../src/db';
import { tenantSecretsRepository } from '../../../src/db/repositories/TenantSecretsRepository';
import {
    AiScopeMissingError,
    currentAiScope,
    requireAiScope,
    runWithAiScope,
} from '../../../src/bard/ai/ambientScope';
import { resolveCredentials } from '../../../src/bard/ai/credentials';
import {
    clearScopeCache,
    runWithSessionScope,
    scopeForCampaign,
    scopeForSession,
} from '../../../src/bard/ai/scope';
import { phaseConfigFor } from '../../../src/bard/config';

const GUILD_A = 'guild-a';
const GUILD_B = 'guild-b';

/** Throwaway master key: it only serves to make writing to the vault possible. */
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

let campaignA: number;
let campaignB: number;

beforeEach(() => {
    process.env.SECRETS_MASTER_KEY = MASTER_KEY;
    wipeDatabase();
    clearScopeCache();
    campaignA = campaignRepository.createCampaign(GUILD_A, 'Tavolo A');
    campaignB = campaignRepository.createCampaign(GUILD_B, 'Tavolo B');
});

afterAll(() => { delete process.env.SECRETS_MASTER_KEY; });

/** A session as the bot writes it, with the guild already set. */
function insertSession(sessionId: string, guildId: string | null, campaignId: number | null) {
    db.prepare('INSERT INTO sessions (session_id, guild_id, campaign_id) VALUES (?, ?, ?)')
        .run(sessionId, guildId, campaignId);
}

describe('deriving the scope', () => {
    it('walks up from the campaign to the guild that owns it', () => {
        expect(scopeForCampaign(campaignA)).toEqual({ guildId: GUILD_A, campaignId: campaignA });
        expect(scopeForCampaign(campaignB)).toEqual({ guildId: GUILD_B, campaignId: campaignB });
    });

    it('walks up from the session to its guild, carrying the campaign', () => {
        // The campaign has to travel too: it is what carries the per-campaign
        // model overrides, and a scope without it would make them invisible to
        // the very pipeline they configure — saved in the settings, ignored at
        // recording time.
        insertSession('sess-1', GUILD_A, campaignA);
        expect(scopeForSession('sess-1')).toEqual({ guildId: GUILD_A, campaignId: campaignA, sessionId: 'sess-1' });
    });

    it('falls back to the campaign for a session with no guild', () => {
        // `sessions.guild_id` is nullable: the sessions predating
        // multi-guild do not have it, and those are exactly the ones already in production.
        insertSession('sess-legacy', null, campaignB);
        expect(scopeForSession('sess-legacy')).toEqual({ guildId: GUILD_B, campaignId: campaignB, sessionId: 'sess-legacy' });
    });

    it('gives a guild-only scope to a session with no campaign', () => {
        insertSession('sess-senza-campagna', GUILD_A, null);
        expect(scopeForSession('sess-senza-campagna')).toEqual({ guildId: GUILD_A, sessionId: 'sess-senza-campagna' });
    });

    it('does not invent a guild for a session that leads nowhere', () => {
        insertSession('sess-orfana', null, null);
        expect(scopeForSession('sess-orfana')).toBeUndefined();
        expect(scopeForSession('mai-esistita')).toBeUndefined();
    });

    it('does not resolve a campaign that does not exist', () => {
        // There is no fallback scope: if we do not know which table pays, the
        // call is not made. The caller passed a wrong id.
        expect(() => scopeForCampaign(999_999)).toThrow(/non si sa chi paga/);
    });
});

describe('scope ambientale', () => {
    it('survives awaits within the same async context', async () => {
        const seen = await runWithAiScope({ guildId: GUILD_A }, async () => {
            await new Promise(resolve => setTimeout(resolve, 1));
            return currentAiScope();
        });
        expect(seen).toEqual({ guildId: GUILD_A });
    });

    it('does not leak one table\'s scope into another\'s', async () => {
        const [a, b] = await Promise.all([
            runWithAiScope({ guildId: GUILD_A }, async () => {
                await new Promise(resolve => setTimeout(resolve, 5));
                return currentAiScope()?.guildId;
            }),
            runWithAiScope({ guildId: GUILD_B }, async () => currentAiScope()?.guildId),
        ]);
        expect([a, b]).toEqual([GUILD_A, GUILD_B]);
    });

    it('re-enters the table\'s scope after the Redis boundary', () => {
        // The job restarts in a fresh async context: the guild is re-read
        // from the database and not from the payload, so a job already queued before the
        // deploy still resolves.
        insertSession('sess-2', GUILD_B, campaignB);
        const seen = runWithSessionScope('sess-2', () => currentAiScope());
        expect(seen).toEqual({ guildId: GUILD_B, campaignId: campaignB, sessionId: 'sess-2' });
    });
});

describe('scope mancante', () => {
    it('throws rather than guessing who pays', () => {
        // No fallback: falling back on the instance scope would mean making
        // the operator pay for a table's work, silently.
        expect(() => requireAiScope()).toThrow(AiScopeMissingError);
    });

    it('there is no instance-wide scope to fall back on', () => {
        // Not even the technical end-of-session mail has one: it is paid for by the guild
        // that started that session, like every other phase.
        expect(() => requireAiScope()).toThrow(AiScopeMissingError);
    });
});

describe('where the credentials come from', () => {
    it('nothing reads the keys from the environment any more', () => {
        // `.env` still carries the keys until the import is run,
        // but nobody looks at them: the vault is the only source, for everyone.
        process.env.OPENAI_API_KEY = 'sk-in-ambiente';
        expect(resolveCredentials('openai', { guildId: GUILD_A }).source).toBe('none');
    });

    it('a table with no keys of its own is given none', () => {
        const resolved = resolveCredentials('openai', { guildId: GUILD_A });
        expect(resolved.source).toBe('none');
        expect(resolved.apiKey).toBeNull();
    });

    it('a table uses the key it put in its own vault', () => {
        tenantSecretsRepository.put(
            { scope: 'guild', scopeId: GUILD_A, secretKey: 'openai.apiKey' },
            'sk-della-gilda-a',
        );

        const a = resolveCredentials('openai', { guildId: GUILD_A });
        const b = resolveCredentials('openai', { guildId: GUILD_B });

        expect(a.source).toBe('tenant');
        expect(a.apiKey?.reveal()).toBe('sk-della-gilda-a');
        // A's key is not visible to B: there is no sharing at all.
        expect(b.source).toBe('none');
    });
});

describe('due tavoli, due configurazioni', () => {
    it('resolves each table to its own model', () => {
        // It is the property that gives the whole of BYOK its meaning: the same phase, in the
        // same process, has to be able to end up on different providers.
        tenantAiSettingsRepository.put('guild', GUILD_A, {
            tiers: { quality: { provider: 'openai', model: 'modello-di-A' } },
        });
        tenantAiSettingsRepository.put('guild', GUILD_B, {
            tiers: { quality: { provider: 'anthropic', model: 'modello-di-B' } },
        });

        const a = phaseConfigFor('analyst', scopeForCampaign(campaignA));
        const b = phaseConfigFor('analyst', scopeForCampaign(campaignB));

        expect([a.provider, a.model]).toEqual(['openai', 'modello-di-A']);
        expect([b.provider, b.model]).toEqual(['anthropic', 'modello-di-B']);
    });

    it('leaves the phases the table does not choose to the file config', () => {
        tenantAiSettingsRepository.put('guild', GUILD_A, {
            tiers: { quality: { provider: 'openai', model: 'solo-qualita' } },
        });

        const quality = phaseConfigFor('analyst', scopeForCampaign(campaignA));
        const fast = phaseConfigFor('metadata', scopeForCampaign(campaignA));

        expect(quality.model).toBe('solo-qualita');
        expect(fast.model).not.toBe('solo-qualita');
    });

    it('the per-phase override beats the group choice', () => {
        tenantAiSettingsRepository.put('guild', GUILD_A, {
            tiers: { quality: { provider: 'openai', model: 'gruppo' } },
            phases: { summary: { provider: 'gemini', model: 'override-writer' } },
        });

        // Same Quality group, different outcomes: it is what makes a campaign's
        // advanced settings possible without one more structure.
        expect(phaseConfigFor('analyst', scopeForCampaign(campaignA)).model).toBe('gruppo');
        expect(phaseConfigFor('summary', scopeForCampaign(campaignA)).model).toBe('override-writer');
    });
});
