/**
 * Test HTTP del flusso merge duplicati:
 *   GET  /api/v1/campaigns/:id/merge/:entityType/duplicates
 *   POST /api/v1/campaigns/:id/merge/:entityType
 *
 * Verifica: detection cluster, merge N→1, guardia manage (403 reader),
 * guardia origin (400 cross-site), report merge.
 */
jest.mock('ioredis', () => {
    const store = new Map<string, string>();
    return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        set: jest.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
        del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
        ttl: jest.fn(async (key: string) => (store.has(key) ? 3600 : -2)),
    }));
});

import type { FastifyInstance } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createNestApp } from '../../../src/api/main';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';
import { type WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { artifactRepository } from '../../../src/db/repositories/ArtifactRepository';
import { factionRepository } from '../../../src/db/repositories/FactionRepository';
import { db, insertKnowledgeFragment } from '../../../src/db';

const GUILD_ID = 'merge-api-guild';
const MANAGER_ID = 'merge-api-manager';
const READER_ID = 'merge-api-reader';

function webSession(discordUserId: string, canManage: boolean): WebSessionData {
    return {
        discordUserId,
        username: discordUserId,
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [{ id: GUILD_ID, name: 'Merge Guild', icon: null, canManage }],
        guildsFetchedAt: Date.now(),
    };
}

describe('Merge duplicates API', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let managerCookie: string;
    let readerCookie: string;
    // short_ids of the two duplicate artifacts
    let keepShortId: string;
    let dropShortId: string;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD_ID, 'Merge API Campaign');
        const u = `${process.pid}-${Date.now()}`;
        // Two artifacts with names that normalize to the same key ("spada" vs "la spada"
        // → normalizeForIndex strips articles → "spada" for both) → a textual cluster.
        artifactRepository.upsertArtifact(campaignId, `La Spada ${u}`, 'FUNCTIONAL', 's1', { description: 'Bio Spada A' });
        artifactRepository.upsertArtifact(campaignId, `Spada ${u}`, 'FUNCTIONAL', 's2', { description: 'Bio Spada B' });

        const a = artifactRepository.getArtifactByName(campaignId, `La Spada ${u}`)!;
        const b = artifactRepository.getArtifactByName(campaignId, `Spada ${u}`)!;
        // give the drop a history event so it has history_count > 0
        artifactRepository.addArtifactEvent(campaignId, `Spada ${u}`, 'sess-1', 'Forgiata anticamente', 'DISCOVERY');
        // the survivor's RAG card (visible in the preview as 'kept')
        insertKnowledgeFragment(campaignId, 'ARTIFACT_UPDATE', `[[SCHEDA ARTEFATTO UFFICIALE: La Spada ${u}]]\nDESCRIZIONE: Bio Spada A`, [0.1, 0.2], 'test-merge-api-model');
        keepShortId = a.short_id!;
        dropShortId = b.short_id!;

        managerCookie = 'merge-api-manager-session';
        readerCookie = 'merge-api-reader-session';
        await signIn(managerCookie, webSession(MANAGER_ID, true));
        await signIn(readerCookie, webSession(READER_ID, false));
    });

    afterAll(async () => {
        await app.close();
    });

    function cookie(cookie: string) {
        return { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
    }

    it('GET /duplicates detects the cluster of duplicate artifacts', async () => {
        const res = await fastify.inject({
            method: 'GET',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts/duplicates`,
            headers: cookie(managerCookie),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.clusters)).toBe(true);
        const cluster = body.clusters.find((c: any) => c.members.length >= 2);
        expect(cluster).toBeDefined();
        expect(cluster.members.some((m: any) => m.short_id === keepShortId)).toBe(true);
        expect(cluster.members.some((m: any) => m.short_id === dropShortId)).toBe(true);
    });

    it('POST /members returns the details for the selected short_ids (no detection)', async () => {
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts/members`,
            headers: { ...cookie(managerCookie), 'content-type': 'application/json' },
            payload: JSON.stringify({ short_ids: [keepShortId, dropShortId] }),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(2);
        expect(body.some((m: any) => m.short_id === keepShortId && m.reason === 'manual_selection')).toBe(true);
        expect(body.some((m: any) => m.short_id === dropShortId)).toBe(true);
        // history_count > 0 for the drop (it has a DISCOVERY)
        const drop = body.find((m: any) => m.short_id === dropShortId);
        expect(drop.history_count).toBeGreaterThan(0);
    });

    it('POST /members is reserved to whoever can manage the campaign', async () => {
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts/members`,
            headers: { ...cookie(readerCookie), 'content-type': 'application/json' },
            payload: JSON.stringify({ short_ids: [keepShortId, dropShortId] }),
        });
        expect(res.statusCode).toBe(403);
    });

    it('POST /merge requires the manage permission (403 for a reader)', async () => {
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts`,
            headers: { ...cookie(readerCookie), 'content-type': 'application/json', origin: `https://app.example.test` },
            payload: JSON.stringify({ keep_short_id: keepShortId, drop_short_ids: [dropShortId] }),
        });
        expect(res.statusCode).toBe(403);
    });

    it('POST /merge rejects a cross-site origin (400)', async () => {
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts`,
            headers: { ...cookie(managerCookie), 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
            payload: JSON.stringify({ keep_short_id: keepShortId, drop_short_ids: [dropShortId] }),
        });
        expect(res.statusCode).toBe(400);
    });

    it('POST /preview returns the diff (record/events/rag) plus the rename when final_name ≠ survivor', async () => {
        const finalName = 'Spada Unita';
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts/preview`,
            headers: { ...cookie(managerCookie), 'content-type': 'application/json', origin: `https://app.example.test` },
            payload: JSON.stringify({ keep_short_id: keepShortId, drop_short_ids: [dropShortId], final_name: finalName }),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.survivor_short_id).toBe(keepShortId);
        expect(body.final_name).toBe(finalName);
        // rename section (final_name ≠ survivor name)
        expect(body.rename).toBeDefined();
        expect(body.rename.to).toBe(finalName);
        // record diff: the two artifacts' descriptions differ
        expect(Array.isArray(body.record)).toBe(true);
        expect(body.record.some((f: any) => f.field === 'description')).toBe(true);
        // events: the drop has a DISCOVERY → repointed onto the survivor
        expect(Array.isArray(body.events)).toBe(true);
        expect(body.events.some((e: any) => e.event_type === 'DISCOVERY')).toBe(true);
        // rag: the survivor's card is visible as 'kept' (a preserved fragment)
        expect(Array.isArray(body.rag)).toBe(true);
        expect(body.rag.some((r: any) => r.action === 'kept')).toBe(true);
    });

    it('POST /merge merges the duplicates and returns the report', async () => {
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts`,
            headers: {
                ...cookie(managerCookie),
                'content-type': 'application/json',
                origin: `https://app.example.test`,
            },
            payload: JSON.stringify({ keep_short_id: keepShortId, drop_short_ids: [dropShortId] }),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.survivor_short_id).toBe(keepShortId);
        expect(body.report.merged_rows).toHaveLength(1);
        expect(body.report.merged_rows[0].short_id).toBe(dropShortId);

        // the drop is deleted, the survivor still exists
        const survivor = db.prepare('SELECT * FROM artifacts WHERE campaign_id = ? AND short_id = ?').get(campaignId, keepShortId);
        const loser = db.prepare('SELECT * FROM artifacts WHERE campaign_id = ? AND short_id = ?').get(campaignId, dropShortId);
        expect(survivor).toBeTruthy();
        expect(loser).toBeUndefined();
    });

    it('POST /merge valida keep non in drop (400)', async () => {
        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts`,
            headers: { ...cookie(managerCookie), 'content-type': 'application/json', origin: `https://app.example.test` },
            payload: JSON.stringify({ keep_short_id: keepShortId, drop_short_ids: [keepShortId] }),
        });
        expect(res.statusCode).toBe(400);
    });

    it('POST /merge with final_name renames the survivor (history + record)', async () => {
        const u2 = `${process.pid}-${Date.now()}-fn`;
        artifactRepository.upsertArtifact(campaignId, `Amuleto Sole ${u2}`, 'FUNCTIONAL', 's1', { description: 'Bio Sole A' });
        artifactRepository.upsertArtifact(campaignId, `Amuleto del Sole ${u2}`, 'FUNCTIONAL', 's2', { description: 'Bio Sole B' });
        const keep = artifactRepository.getArtifactByName(campaignId, `Amuleto Sole ${u2}`)!;
        const drop = artifactRepository.getArtifactByName(campaignId, `Amuleto del Sole ${u2}`)!;
        const finalName = `Amuleto del Sole (${u2})`;

        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts`,
            headers: { ...cookie(managerCookie), 'content-type': 'application/json', origin: `https://app.example.test` },
            payload: JSON.stringify({ keep_short_id: keep.short_id, drop_short_ids: [drop.short_id], final_name: finalName }),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.survivor_name).toBe(finalName);
        expect(body.report.renamed).toBeDefined();
        expect(body.report.renamed.to).toBe(finalName);

        // the survivor has been renamed in the DB
        const renamed = db.prepare('SELECT * FROM artifacts WHERE campaign_id = ? AND short_id = ?').get(campaignId, keep.short_id) as any;
        expect(renamed.name).toBe(finalName);
    });

    it('preview includes the description override in the surviving value', async () => {
        const suffix = `${process.pid}-${Date.now()}-override`;
        artifactRepository.upsertArtifact(campaignId, `Reliquia A ${suffix}`, 'FUNCTIONAL', 's1', { description: 'Bio A' });
        artifactRepository.upsertArtifact(campaignId, `Reliquia B ${suffix}`, 'FUNCTIONAL', 's2', { description: 'Bio B' });
        const keep = artifactRepository.getArtifactByName(campaignId, `Reliquia A ${suffix}`)!;
        const drop = artifactRepository.getArtifactByName(campaignId, `Reliquia B ${suffix}`)!;

        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts/preview`,
            headers: { ...cookie(managerCookie), 'content-type': 'application/json' },
            payload: JSON.stringify({
                keep_short_id: keep.short_id,
                drop_short_ids: [drop.short_id],
                description: 'Bio finale scelta',
            }),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        const description = body.record.find((field: any) => field.field === 'description');
        expect(description.survivor_value).toBe('Bio finale scelta');
        expect(description.verdict).toBe('differs');
    });

    it('rejects a final_name already taken before touching any record', async () => {
        const suffix = `${process.pid}-${Date.now()}-collision`;
        const keepName = `Talismano A ${suffix}`;
        const dropName = `Talismano B ${suffix}`;
        const occupiedName = `Talismano esistente ${suffix}`;
        artifactRepository.upsertArtifact(campaignId, keepName, 'FUNCTIONAL', 's1');
        artifactRepository.upsertArtifact(campaignId, dropName, 'FUNCTIONAL', 's2');
        artifactRepository.upsertArtifact(campaignId, occupiedName, 'FUNCTIONAL', 's3');
        const keep = artifactRepository.getArtifactByName(campaignId, keepName)!;
        const drop = artifactRepository.getArtifactByName(campaignId, dropName)!;

        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts`,
            headers: {
                ...cookie(managerCookie),
                'content-type': 'application/json',
                origin: `https://app.example.test`,
            },
            payload: JSON.stringify({
                keep_short_id: keep.short_id,
                drop_short_ids: [drop.short_id],
                final_name: occupiedName,
            }),
        });
        expect(res.statusCode).toBe(409);
        expect(artifactRepository.getArtifactByName(campaignId, keepName)).toBeTruthy();
        expect(artifactRepository.getArtifactByName(campaignId, dropName)).toBeTruthy();
        expect(artifactRepository.getArtifactByName(campaignId, occupiedName)).toBeTruthy();
    });

    it('consolidates the stale RAG snapshots and keeps a single one on the survivor', async () => {
        const suffix = `${process.pid}-${Date.now()}-rag-count`;
        const keepName = `Sigillo A ${suffix}`;
        const dropName = `Sigillo B ${suffix}`;
        artifactRepository.upsertArtifact(campaignId, keepName, 'FUNCTIONAL', 's1');
        artifactRepository.upsertArtifact(campaignId, dropName, 'FUNCTIONAL', 's2');
        const keep = artifactRepository.getArtifactByName(campaignId, keepName)!;
        const drop = artifactRepository.getArtifactByName(campaignId, dropName)!;
        const keepHeader = `[[SCHEDA ARTEFATTO UFFICIALE: ${keepName}]]`;
        const header = `[[SCHEDA ARTEFATTO UFFICIALE: ${dropName}]]`;
        insertKnowledgeFragment(campaignId, 'ARTIFACT_UPDATE', `${keepHeader}\nVersione survivor uno`, [0.1], 'test-count-model');
        insertKnowledgeFragment(campaignId, 'ARTIFACT_UPDATE', `${keepHeader}\nVersione survivor due`, [0.2], 'test-count-model');
        insertKnowledgeFragment(campaignId, 'ARTIFACT_UPDATE', `${header}\nVersione uno`, [0.1], 'test-count-model');
        insertKnowledgeFragment(campaignId, 'ARTIFACT_UPDATE', `${header}\nVersione due`, [0.2], 'test-count-model');

        const res = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/artifacts`,
            headers: {
                ...cookie(managerCookie),
                'content-type': 'application/json',
                origin: `https://app.example.test`,
            },
            payload: JSON.stringify({ keep_short_id: keep.short_id, drop_short_ids: [drop.short_id] }),
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).report.rag_fragments_deleted).toBe(3);
        const survivorCards = db.prepare(`
            SELECT id FROM knowledge_fragments
            WHERE campaign_id = ? AND session_id = 'ARTIFACT_UPDATE' AND INSTR(content, ?) > 0
        `).all(campaignId, keepHeader);
        expect(survivorCards).toHaveLength(1);
    });

    it('uses the same preview + N→1 merge for factions', async () => {
        const suffix = `${process.pid}-${Date.now()}-factions`;
        const dropName = `Dame di Ferro ${suffix}`;
        const keepName = `Vergini di Ferro ${suffix}`;
        factionRepository.createFaction(campaignId, dropName, {
            description: 'Guardia imperiale',
            type: 'ORGANIZATION',
        });
        factionRepository.createFaction(campaignId, keepName, {
            description: 'Ordine delle guerriere',
            type: 'ORGANIZATION',
        });
        const drop = factionRepository.getFaction(campaignId, dropName)!;
        const keep = factionRepository.getFaction(campaignId, keepName)!;
        factionRepository.addAffiliation(drop.id, 'npc', 999_001, { role: 'MEMBER' });
        factionRepository.addFactionEvent(
            campaignId,
            dropName,
            'sess-factions',
            'Ha difeso Caelum',
            'ALLIANCE',
        );
        insertKnowledgeFragment(
            campaignId,
            'FACTION_UPDATE',
            `[[SCHEDA FAZIONE UFFICIALE: ${dropName}]]\nGuardia imperiale`,
            [0.1],
            'test-merge-api-model',
            0,
            null,
            null,
            [dropName],
        );

        const preview = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/factions/preview`,
            headers: { ...cookie(managerCookie), 'content-type': 'application/json' },
            payload: JSON.stringify({
                keep_short_id: keep.short_id,
                drop_short_ids: [drop.short_id],
            }),
        });
        expect(preview.statusCode).toBe(200);
        const previewBody = JSON.parse(preview.body);
        expect(previewBody.events).toHaveLength(1);
        expect(previewBody.relations).toHaveLength(1);
        expect(previewBody.relations[0].action).toBe('repointed');
        expect(previewBody.rag.some((row: any) => row.action === 'consolidated')).toBe(true);

        const merged = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/merge/factions`,
            headers: {
                ...cookie(managerCookie),
                'content-type': 'application/json',
                origin: 'https://app.example.test',
            },
            payload: JSON.stringify({
                keep_short_id: keep.short_id,
                drop_short_ids: [drop.short_id],
            }),
        });
        expect(merged.statusCode).toBe(200);
        const mergedBody = JSON.parse(merged.body);
        expect(mergedBody.survivor_short_id).toBe(keep.short_id);
        expect(mergedBody.report.relations_repointed).toBe(1);
        expect(factionRepository.getFaction(campaignId, dropName)).toBeNull();
        expect(factionRepository.getFaction(campaignId, keepName)).toBeTruthy();
    });

    it('rolls the whole N→1 batch back if one of the losers fails', async () => {
        const suffix = `${process.pid}-${Date.now()}-atomic`;
        const keepName = `Idolo A ${suffix}`;
        const firstDropName = `Idolo B ${suffix}`;
        const secondDropName = `Idolo C ${suffix}`;
        artifactRepository.upsertArtifact(campaignId, keepName, 'FUNCTIONAL', 's1');
        artifactRepository.upsertArtifact(campaignId, firstDropName, 'FUNCTIONAL', 's2');
        artifactRepository.upsertArtifact(campaignId, secondDropName, 'FUNCTIONAL', 's3');
        const keep = artifactRepository.getArtifactByName(campaignId, keepName)!;
        const firstDrop = artifactRepository.getArtifactByName(campaignId, firstDropName)!;
        const secondDrop = artifactRepository.getArtifactByName(campaignId, secondDropName)!;
        const triggerName = 'test_merge_atomicity_abort';

        db.exec(`
            DROP TRIGGER IF EXISTS ${triggerName};
            CREATE TRIGGER ${triggerName}
            BEFORE DELETE ON artifacts
            WHEN OLD.id = ${Number(secondDrop.id)}
            BEGIN
                SELECT RAISE(ABORT, 'forced merge failure');
            END;
        `);
        try {
            const res = await fastify.inject({
                method: 'POST',
                url: `/api/v1/campaigns/${campaignId}/merge/artifacts`,
                headers: {
                    ...cookie(managerCookie),
                    'content-type': 'application/json',
                    origin: `https://app.example.test`,
                },
                payload: JSON.stringify({
                    keep_short_id: keep.short_id,
                    drop_short_ids: [firstDrop.short_id, secondDrop.short_id],
                }),
            });
            expect(res.statusCode).toBe(500);
        } finally {
            db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
        }

        expect(artifactRepository.getArtifactByName(campaignId, keepName)).toBeTruthy();
        expect(artifactRepository.getArtifactByName(campaignId, firstDropName)).toBeTruthy();
        expect(artifactRepository.getArtifactByName(campaignId, secondDropName)).toBeTruthy();
    });
});
