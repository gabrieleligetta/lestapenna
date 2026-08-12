// No real Redis in the test environment — same in-memory fake as campaigns.test.ts.
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

import { createNestApp } from '../../../src/api/main';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyInstance } from 'fastify';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { ensureMembership } from '../../../src/services/campaignAccess';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { factionRepository } from '../../../src/db/repositories/FactionRepository';
import { db } from '../../../src/db';
import { WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';

const GUILD = 'crud-guild';
const OTHER_GUILD = 'crud-other-guild';

function fakeSession(canManage: boolean, userId = 'user-crud', guildId = GUILD): WebSessionData {
    return {
        discordUserId: userId,
        username: 'tester',
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [{ id: guildId, name: 'CRUD Table', icon: null, canManage }],
        guildsFetchedAt: Date.now(),
    };
}

/**
 * The unified entity CRUD (src/api/campaigns/crud).
 *
 * The routes are parametric on `:entityType`, so what matters here is mostly
 * what the registry makes different between one family and another: the delete
 * cascade, the alignment weights that exist only on three histories, and the
 * RAG memory, which is the one thing that survives the entity row if nobody
 * cleans it up.
 */
describe('Entity CRUD (registry unificato)', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let managerCookie: string;
    let readerCookie: string;
    let playerCookie: string;
    let outsiderCookie: string;
    let otherGuildCookie: string;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD, 'CRUD Campaign');

        managerCookie = 'crud-manager-session';
        await signIn(managerCookie, fakeSession(true));
        readerCookie = 'crud-reader-session';
        await signIn(readerCookie, fakeSession(false));

        // A player at the table: no Discord permission, but enrolled in the campaign.
        playerCookie = 'crud-player-session';
        await signIn(playerCookie, fakeSession(false, 'user-player'));
        ensureMembership(campaignId, 'user-player');

        // A member of the same guild who is not at the table.
        outsiderCookie = 'crud-outsider-session';
        await signIn(outsiderCookie, fakeSession(false, 'user-outsider'));

        // An administrator of ANOTHER server: they must not be able to touch anything here.
        otherGuildCookie = 'crud-other-guild-session';
        await signIn(otherGuildCookie, fakeSession(true, 'user-elsewhere', OTHER_GUILD));
    });

    afterAll(async () => {
        await app.close();
    });

    function get(url: string, cookie = managerCookie) {
        return fastify.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
    }

    function mutate(
        method: 'POST' | 'PATCH' | 'DELETE',
        url: string,
        payload?: Record<string, unknown>,
        cookie = managerCookie,
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

    const base = () => `/api/v1/campaigns/${campaignId}`;

    describe('create / update / delete', () => {
        it('creates, edits and deletes an NPC through the parametric routes', async () => {
            const created = await mutate('POST', `${base()}/npcs`, {
                name: 'Vess il Silente',
                description: 'Custode del passo.',
                role: 'Guardiano',
                status: 'ALIVE',
                aliases: ['Il Silente', 'Vess'],
            });
            expect(created.statusCode).toBe(201);
            const npc = JSON.parse(created.payload);
            expect(npc).toMatchObject({ name: 'Vess il Silente', role: 'Guardiano', status: 'ALIVE' });
            expect(npc.short_id).toEqual(expect.any(String));
            // The projection is the same as the lists': no internal columns.
            expect(npc).not.toHaveProperty('rag_sync_needed');
            expect(npc).not.toHaveProperty('manual_description');

            const updated = await mutate('PATCH', `${base()}/npcs/${npc.short_id}`, { status: 'DEAD' });
            expect(updated.statusCode).toBe(200);
            expect(JSON.parse(updated.payload)).toMatchObject({ status: 'DEAD', name: 'Vess il Silente' });

            const removed = await mutate('DELETE', `${base()}/npcs/${npc.short_id}`);
            expect(removed.statusCode).toBe(200);
            expect(JSON.parse(removed.payload).name).toBe('Vess il Silente');
            expect((await get(`${base()}/npcs/${npc.short_id}`)).statusCode).toBe(404);
        });

        it('creates a location on its composite key and renames it', async () => {
            const created = await mutate('POST', `${base()}/locations`, {
                macro_location: 'Valle Grigia',
                micro_location: 'Ponte spezzato',
                description: 'Un ponte crollato sopra il fiume.',
            });
            expect(created.statusCode).toBe(201);
            const place = JSON.parse(created.payload);

            const renamed = await mutate('PATCH', `${base()}/locations/${place.short_id}`, {
                micro_location: 'Ponte ricostruito',
            });
            expect(renamed.statusCode).toBe(200);
            expect(JSON.parse(renamed.payload)).toMatchObject({
                macro_location: 'Valle Grigia',
                micro_location: 'Ponte ricostruito',
            });
        });

        it('rejects an unknown entity type and unknown fields instead of ignoring them', async () => {
            expect((await mutate('POST', `${base()}/dragons`, { name: 'x' })).statusCode).toBe(400);

            const unknownField = await mutate('POST', `${base()}/npcs`, {
                name: 'Con campo ignoto',
                alignment_moral: 'GOOD',
            });
            expect(unknownField.statusCode).toBe(400);
            expect(JSON.parse(unknownField.payload).message).toMatch(/alignment_moral/);
        });

        it('refuses a rename onto an existing name: merging stays the merge flow', async () => {
            npcRepository.updateNpcEntry(campaignId, 'Dama di Ferro', 'Prima', undefined, undefined, undefined, true);
            npcRepository.updateNpcEntry(campaignId, 'Vergine di Ferro', 'Seconda', undefined, undefined, undefined, true);
            const target = npcRepository.getNpcEntry(campaignId, 'Vergine di Ferro')!;

            const conflict = await mutate('PATCH', `${base()}/npcs/${target.short_id}`, {
                name: 'Dama di Ferro',
            });
            expect(conflict.statusCode).toBe(409);
            // Neither of the two cards was touched.
            expect(npcRepository.getNpcEntry(campaignId, 'Vergine di Ferro')).toBeDefined();
            expect(npcRepository.getNpcEntry(campaignId, 'Dama di Ferro')).toBeDefined();
        });

        it('never deletes the Party faction', async () => {
            const party = factionRepository.createPartyFaction(campaignId, 'La Compagnia')!;
            const blocked = await mutate('DELETE', `${base()}/factions/${party.short_id}`);
            expect(blocked.statusCode).toBe(400);
            expect(factionRepository.getPartyFaction(campaignId)).not.toBeNull();
        });

        it('lets a table player write without any Discord permission', async () => {
            // ManageGuild used to be required: someone who played could not fix
            // even a wrong description generated by the AI.
            const created = await mutate('POST', `${base()}/npcs`, { name: 'Creato dal giocatore' }, playerCookie);
            expect(created.statusCode).toBe(201);

            const npc = JSON.parse(created.payload);
            expect((await mutate('DELETE', `${base()}/npcs/${npc.short_id}`, undefined, playerCookie)).statusCode)
                .toBe(200);
        });

        it('refuses a guild member who is not part of the campaign', async () => {
            const created = await mutate('POST', `${base()}/npcs`, { name: 'Estraneo' }, outsiderCookie);
            expect(created.statusCode).toBe(403);
        });

        it('still lets that guild member read the whole campaign', async () => {
            // Whoever is in the server but not at the table stays a spectator: the
            // campaign can be consulted, it just cannot be modified.
            const seed = JSON.parse((await mutate('POST', `${base()}/npcs`, { name: 'Visibile' })).payload);

            expect((await get(`${base()}`, outsiderCookie)).statusCode).toBe(200);
            expect((await get(`${base()}/npcs`, outsiderCookie)).statusCode).toBe(200);
            expect((await get(`${base()}/npcs/${seed.short_id}`, outsiderCookie)).statusCode).toBe(200);
            expect((await get(`${base()}/npcs/${seed.short_id}/events`, outsiderCookie)).statusCode).toBe(200);
            // The Bardo's memory too: reading it is looking at the campaign.
            expect((await get(`${base()}/npcs/${seed.short_id}/fragments`, outsiderCookie)).statusCode).toBe(200);
            expect((await get(`${base()}/quests/lifecycle-suggestions`, outsiderCookie)).statusCode).toBe(200);
        });

        it('reports the spectator as read-only in the overview', async () => {
            const overview = JSON.parse((await get(`${base()}`, outsiderCookie)).payload);
            expect(overview).toMatchObject({ myRole: null, canWrite: false, canManageMembers: false });
        });

        it('refuses every write from another guild, even to an administrator there', async () => {
            // This is the "I guess or sniff another server's campaignId" scenario:
            // CampaignAccessGuard resolves the guild that owns the campaign and
            // compares it with the session's.
            const seed = JSON.parse((await mutate('POST', `${base()}/npcs`, { name: 'Bersaglio' })).payload);

            expect((await mutate('POST', `${base()}/npcs`, { name: 'Intruso' }, otherGuildCookie)).statusCode)
                .toBe(403);
            expect((await mutate('PATCH', `${base()}/npcs/${seed.short_id}`, { status: 'DEAD' }, otherGuildCookie)).statusCode)
                .toBe(403);
            expect((await mutate('DELETE', `${base()}/npcs/${seed.short_id}`, undefined, otherGuildCookie)).statusCode)
                .toBe(403);

            // L'entità è intatta.
            expect((await get(`${base()}/npcs/${seed.short_id}`)).statusCode).toBe(200);
        });
    });

    describe('cascade delete', () => {
        it('takes the history, the RAG entry and the typed refs with the entity', async () => {
            const created = await mutate('POST', `${base()}/npcs`, { name: 'Mira la Cieca' });
            const npc = JSON.parse(created.payload);
            const npcId = npcRepository.getNpcEntry(campaignId, 'Mira la Cieca')!.id;

            npcRepository.addNpcEvent(campaignId, 'Mira la Cieca', 'session-x', 'Ha aperto la cripta.', 'GENERIC', true);
            // An official card + a session memory that cites it by id.
            db.prepare(`
                INSERT INTO knowledge_fragments
                    (campaign_id, session_id, content, embedding_json, embedding_model, associated_entity_ids)
                VALUES (?, 'DOSSIER_UPDATE', ?, '[]', 'nomic-embed-text', NULL)
            `).run(campaignId, '[[SCHEDA UFFICIALE: Mira la Cieca]]\nUna veggente.');
            db.prepare(`
                INSERT INTO knowledge_fragments
                    (campaign_id, session_id, content, embedding_json, embedding_model, associated_entity_ids)
                VALUES (?, 'session-x', 'La cripta si aprì.', '[]', 'nomic-embed-text', ?)
            `).run(campaignId, `npc:${npcId},quest:99`);

            const removed = await mutate('DELETE', `${base()}/npcs/${npc.short_id}`);
            expect(removed.statusCode).toBe(200);
            const { report } = JSON.parse(removed.payload);
            expect(report.history_deleted).toBe(1);
            expect(report.rag_fragments_deleted).toBe(2);

            expect(
                db.prepare('SELECT COUNT(*) c FROM npc_history WHERE campaign_id = ? AND npc_name = ?')
                    .get(campaignId, 'Mira la Cieca'),
            ).toEqual({ c: 0 });
            expect(
                db.prepare(`SELECT COUNT(*) c FROM knowledge_fragments
                            WHERE campaign_id = ? AND INSTR(COALESCE(associated_entity_ids, ''), ?) > 0`)
                    .get(campaignId, `npc:${npcId}`),
            ).toEqual({ c: 0 });
        });
    });

    describe('history events', () => {
        it('exposes the alignment weights and re-aggregates the entity on edit', async () => {
            const created = await mutate('POST', `${base()}/npcs`, { name: 'Toran il Giusto' });
            const npc = JSON.parse(created.payload);
            npcRepository.addNpcEvent(
                campaignId, 'Toran il Giusto', 'session-y', 'Ha protetto i profughi.', 'GENERIC',
                true, undefined, 4, 0,
            );

            const events = await get(`${base()}/npcs/${npc.short_id}/events`);
            const [event] = JSON.parse(events.payload).items;
            expect(event).toMatchObject({ moral_weight: 4, ethical_weight: 0 });
            expect(npcRepository.getNpcEntry(campaignId, 'Toran il Giusto')!.moral_score).toBe(40);

            const patched = await mutate('PATCH', `${base()}/npcs/${npc.short_id}/events/${event.id}`, {
                moral_weight: -6,
            });
            expect(patched.statusCode).toBe(204);

            // The aggregated score cannot lag behind the
            // events it is derived from.
            const after = npcRepository.getNpcEntry(campaignId, 'Toran il Giusto')!;
            expect(after.moral_score).toBe(-60);
            expect(after.alignment_moral).toBe('EVIL');
        });

        it('recomputes the alignment after an event is deleted', async () => {
            const created = await mutate('POST', `${base()}/npcs`, { name: 'Sela la Mite' });
            const npc = JSON.parse(created.payload);
            npcRepository.addNpcEvent(campaignId, 'Sela la Mite', 's1', 'Buona azione.', 'GENERIC', true, undefined, 5, 0);
            npcRepository.addNpcEvent(campaignId, 'Sela la Mite', 's2', 'Azione crudele.', 'GENERIC', true, undefined, -5, 0);
            expect(npcRepository.getNpcEntry(campaignId, 'Sela la Mite')!.moral_score).toBe(0);

            const events = JSON.parse((await get(`${base()}/npcs/${npc.short_id}/events`)).payload).items;
            const cruel = events.find((row: { description: string }) => row.description === 'Azione crudele.');

            const removed = await mutate('DELETE', `${base()}/npcs/${npc.short_id}/events/${cruel.id}`);
            expect(removed.statusCode).toBe(204);
            expect(npcRepository.getNpcEntry(campaignId, 'Sela la Mite')!.moral_score).toBe(50);
        });

        it('refuses weights on a history table that has none', async () => {
            const created = await mutate('POST', `${base()}/quests`, {
                title: 'Trovare il passo',
                status: 'OPEN',
                type: 'MINOR',
            });
            const quest = JSON.parse(created.payload);
            const events = JSON.parse((await get(`${base()}/quests/${quest.short_id}/events`)).payload).items;
            expect(events[0]).toMatchObject({ moral_weight: null, ethical_weight: null });

            const rejected = await mutate(
                'PATCH',
                `${base()}/quests/${quest.short_id}/events/${events[0].id}`,
                { moral_weight: 3 },
            );
            expect(rejected.statusCode).toBe(400);
        });

        it('will not edit an event that belongs to another entity', async () => {
            const first = JSON.parse((await mutate('POST', `${base()}/npcs`, { name: 'Uno' })).payload);
            const second = JSON.parse((await mutate('POST', `${base()}/npcs`, { name: 'Due' })).payload);
            npcRepository.addNpcEvent(campaignId, 'Uno', 's1', 'Evento di Uno.', 'GENERIC', true);

            const events = JSON.parse((await get(`${base()}/npcs/${first.short_id}/events`)).payload).items;
            const stolen = await mutate(
                'PATCH',
                `${base()}/npcs/${second.short_id}/events/${events[0].id}`,
                { description: 'Riscritto da un altro NPC' },
            );
            expect(stolen.statusCode).toBe(404);
        });
    });

    describe('RAG fragments', () => {
        it('lists the linked fragments and deletes only one of them', async () => {
            const created = JSON.parse((await mutate('POST', `${base()}/npcs`, { name: 'Orlo il Cronista' })).payload);
            const npcId = npcRepository.getNpcEntry(campaignId, 'Orlo il Cronista')!.id;

            db.prepare(`
                INSERT INTO knowledge_fragments
                    (campaign_id, session_id, content, embedding_json, embedding_model, created_at)
                VALUES (?, 'DOSSIER_UPDATE', ?, '[]', 'nomic-embed-text', 2000)
            `).run(campaignId, '[[SCHEDA UFFICIALE: Orlo il Cronista]]\nScrive tutto.');
            db.prepare(`
                INSERT INTO knowledge_fragments
                    (campaign_id, session_id, content, embedding_json, embedding_model, associated_entity_ids, created_at)
                VALUES (?, 'session-z', 'Orlo annotò la resa.', '[]', 'nomic-embed-text', ?, 1000)
            `).run(campaignId, `npc:${npcId}`);

            const listed = await get(`${base()}/npcs/${created.short_id}/fragments`);
            expect(listed.statusCode).toBe(200);
            const page = JSON.parse(listed.payload);
            expect(page.total).toBe(2);
            // The official card is distinct from the session memory: only the
            // latter is unrecoverable once deleted.
            expect(page.items[0]).toMatchObject({ is_entity_snapshot: true });
            expect(page.items[1]).toMatchObject({ is_entity_snapshot: false });
            expect(page.items[0]).not.toHaveProperty('embedding_json');

            const memoryId = page.items[1].id;
            expect((await mutate('DELETE', `${base()}/npcs/${created.short_id}/fragments/${memoryId}`)).statusCode)
                .toBe(204);

            const after = JSON.parse((await get(`${base()}/npcs/${created.short_id}/fragments`)).payload);
            expect(after.total).toBe(1);
            expect(after.items[0].is_entity_snapshot).toBe(true);
        });

        it('will not delete a fragment that is not linked to that entity', async () => {
            const created = JSON.parse((await mutate('POST', `${base()}/npcs`, { name: 'Nessun Legame' })).payload);
            const orphan = db.prepare(`
                INSERT INTO knowledge_fragments
                    (campaign_id, session_id, content, embedding_json, embedding_model)
                VALUES (?, 'session-w', 'Un ricordo che non lo nomina.', '[]', 'nomic-embed-text')
            `).run(campaignId).lastInsertRowid as number;

            const refused = await mutate('DELETE', `${base()}/npcs/${created.short_id}/fragments/${orphan}`);
            expect(refused.statusCode).toBe(404);
            expect(db.prepare('SELECT COUNT(*) c FROM knowledge_fragments WHERE id = ?').get(orphan)).toEqual({ c: 1 });
        });
    });
});
