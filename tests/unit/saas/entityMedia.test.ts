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

jest.mock('../../../src/services/backup', () => ({
    ...jest.requireActual('../../../src/services/backup'),
    cloudObjectExists: jest.fn().mockResolvedValue(false),
}));

import { promises as fs } from 'fs';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createNestApp } from '../../../src/api/main';
import { SESSION_COOKIE_NAME } from '../../../src/api/auth/session.guard';
import { type WebSessionData } from '../../../src/api/auth/webSession.store';
import { signIn } from '../../fixtures/signIn';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { characterRepository } from '../../../src/db/repositories/CharacterRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { locationRepository } from '../../../src/db/repositories/LocationRepository';
import { artifactRepository } from '../../../src/db/repositories/ArtifactRepository';
import { inventoryRepository } from '../../../src/db/repositories/InventoryRepository';
import { sessionRepository } from '../../../src/db/repositories/SessionRepository';
import { entityMediaRepository } from '../../../src/db/repositories/EntityMediaRepository';
import { config } from '../../../src/config';
import { db } from '../../../src/db';

const GUILD_ID = 'entity-media-guild';
const MANAGER_ID = 'entity-media-manager';
const OWNER_ID = 'entity-media-owner';
const READER_ID = 'entity-media-reader';

function webSession(discordUserId: string, canManage: boolean): WebSessionData {
    return {
        discordUserId,
        username: discordUserId,
        globalName: null,
        avatar: null,
        accessToken: 'irrelevant',
        refreshToken: 'irrelevant',
        tokenExpiresAt: Date.now() + 999_999_999,
        guilds: [{ id: GUILD_ID, name: 'Media Guild', icon: null, canManage }],
        guildsFetchedAt: Date.now(),
    };
}

function multipartPayload(
    image: Buffer,
    fields: Record<string, string> = {},
): { boundary: string; body: Buffer } {
    const boundary = `lestapenna-media-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const chunks: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
        chunks.push(
            Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
                `${value}\r\n`,
            ),
        );
    }
    chunks.push(
        Buffer.from(
            `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="file"; filename="portrait.png"\r\n' +
            'Content-Type: image/png\r\n\r\n',
        ),
        image,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return { boundary, body: Buffer.concat(chunks) };
}

describe('Entity media API (VIS-06)', () => {
    let app: NestFastifyApplication;
    let fastify: FastifyInstance;
    let campaignId: number;
    let managerCookie: string;
    let ownerCookie: string;
    let readerCookie: string;
    let png: Buffer;

    beforeAll(async () => {
        app = await createNestApp();
        await app.init();
        fastify = app.getHttpAdapter().getInstance();

        campaignId = campaignRepository.createCampaign(GUILD_ID, 'Entity Media Campaign');
        const unique = `${process.pid}-${Date.now()}`;
        npcRepository.updateNpcEntry(
            campaignId,
            `Media NPC ${unique}`,
            'Keeper of an illustrated archive',
        );
        locationRepository.updateAtlasEntry(
            campaignId,
            `Media Region ${unique}`,
            'Moonlit Library',
            'Shelves lit by quiet spellfire',
        );
        artifactRepository.upsertArtifact(
            campaignId,
            `Media Artifact ${unique}`,
            'FUNCTIONAL',
            undefined,
            { description: 'An illuminated codex' },
        );
        characterRepository.updateUserCharacter(OWNER_ID, campaignId, 'character_name', 'The Archivist');

        managerCookie = 'entity-media-manager-session';
        ownerCookie = 'entity-media-owner-session';
        readerCookie = 'entity-media-reader-session';
        await signIn(managerCookie, webSession(MANAGER_ID, true));
        await signIn(ownerCookie, webSession(OWNER_ID, false));
        await signIn(readerCookie, webSession(READER_ID, false));

        png = await sharp({
            create: {
                width: 900,
                height: 600,
                channels: 4,
                background: { r: 40, g: 20, b: 90, alpha: 1 },
            },
        }).png().toBuffer();
    });

    afterAll(async () => {
        await app.close();
        if (config.mediaStorage.localDirectory.includes('lestapenna_test_media_')) {
            await fs.rm(config.mediaStorage.localDirectory, { recursive: true, force: true });
        }
    });

    function cookieHeader(cookie: string) {
        return { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
    }

    async function upload(
        entityType: string,
        entityId: string,
        cookie: string,
        input: Buffer = png,
        fields: Record<string, string> = {},
        extraHeaders: Record<string, string> = {},
    ) {
        const multipart = multipartPayload(input, fields);
        return fastify.inject({
            method: 'PUT',
            url: `/api/v1/campaigns/${campaignId}/${entityType}/${entityId}/image`,
            headers: {
                ...cookieHeader(cookie),
                'content-type': `multipart/form-data; boundary=${multipart.boundary}`,
                ...extraHeaders,
            },
            payload: multipart.body,
        });
    }

    function get(url: string, cookie: string = managerCookie) {
        return fastify.inject({ method: 'GET', url, headers: cookieHeader(cookie) });
    }

    it('validates image data and limits write access to managers or the character owner', async () => {
        const npc = db.prepare(
            'SELECT short_id FROM npc_dossier WHERE campaign_id = ?',
        ).get(campaignId) as { short_id: string };

        const readOnly = await upload('npc', npc.short_id, readerCookie);
        expect(readOnly.statusCode).toBe(403);

        const invalid = await upload('npc', npc.short_id, managerCookie, Buffer.from('not an image'));
        expect(invalid.statusCode).toBe(400);

        const crossSite = await upload('npc', npc.short_id, managerCookie, png, {}, {
            origin: 'https://attacker.example',
        });
        expect(crossSite.statusCode).toBe(400);

        const otherCharacter = await upload('character', OWNER_ID, readerCookie);
        expect(otherCharacter.statusCode).toBe(403);

        const ownedCharacter = await upload(
            'character',
            OWNER_ID,
            ownerCookie,
            png,
            { focalX: '35', focalY: '65', altText: 'The Archivist' },
        );
        expect(ownedCharacter.statusCode).toBe(200);
        expect(JSON.parse(ownedCharacter.payload)).toMatchObject({
            focalX: 35,
            focalY: 65,
            altText: 'The Archivist',
        });
    });

    it('serves private WebP variants and enriches lists/details through one bulk media query', async () => {
        const npc = db.prepare('SELECT id, short_id FROM npc_dossier WHERE campaign_id = ?').get(campaignId) as {
            id: number;
            short_id: string;
        };
        const location = db.prepare('SELECT id, short_id FROM location_atlas WHERE campaign_id = ?').get(campaignId) as {
            id: number;
            short_id: string;
        };
        const artifact = db.prepare('SELECT id, short_id, name FROM artifacts WHERE campaign_id = ?').get(campaignId) as {
            id: number;
            short_id: string;
            name: string;
        };

        const npcUpload = await upload(
            'npc',
            npc.short_id,
            managerCookie,
            png,
            { focalX: '25', focalY: '75', altText: 'Archive keeper' },
        );
        const locationUpload = await upload('location', location.short_id, managerCookie);
        const artifactUpload = await upload('artifact', artifact.short_id, managerCookie);
        expect([npcUpload.statusCode, locationUpload.statusCode, artifactUpload.statusCode]).toEqual([200, 200, 200]);

        const npcImage = JSON.parse(npcUpload.payload);
        expect(npcImage).toMatchObject({
            thumbnailUrl: `/api/v1/campaigns/${campaignId}/media/${npcImage.id}/thumbnail`,
            displayUrl: `/api/v1/campaigns/${campaignId}/media/${npcImage.id}/display`,
            width: 900,
            height: 600,
            focalX: 25,
            focalY: 75,
            altText: 'Archive keeper',
        });

        const thumbnail = await get(npcImage.thumbnailUrl);
        expect(thumbnail.statusCode).toBe(200);
        expect(thumbnail.headers['content-type']).toContain('image/webp');
        expect(thumbnail.headers['cache-control']).toBe('private, max-age=300');
        expect(thumbnail.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(thumbnail.rawPayload.subarray(8, 12).toString('ascii')).toBe('WEBP');

        const bulkSpy = jest.spyOn(entityMediaRepository, 'getForEntities');
        const npcList = await get(`/api/v1/campaigns/${campaignId}/npcs`);
        expect(npcList.statusCode).toBe(200);
        expect(JSON.parse(npcList.payload).items[0].image.id).toBe(npcImage.id);
        expect(bulkSpy).toHaveBeenCalledTimes(1);
        bulkSpy.mockRestore();

        const npcDetail = await get(`/api/v1/campaigns/${campaignId}/npcs/${npc.short_id}`);
        const locationList = await get(`/api/v1/campaigns/${campaignId}/locations`);
        const locationDetail = await get(`/api/v1/campaigns/${campaignId}/locations/${location.short_id}`);
        const artifactList = await get(`/api/v1/campaigns/${campaignId}/artifacts`);
        const artifactDetail = await get(`/api/v1/campaigns/${campaignId}/artifacts/${artifact.short_id}`);
        expect(JSON.parse(npcDetail.payload).image.id).toBe(npcImage.id);
        expect(JSON.parse(locationList.payload).items[0].image).not.toBeNull();
        expect(JSON.parse(locationDetail.payload).image).not.toBeNull();
        expect(JSON.parse(artifactList.payload).items[0].image).not.toBeNull();
        expect(JSON.parse(artifactDetail.payload).image).not.toBeNull();

        inventoryRepository.addLoot(campaignId, artifact.name, 1, 'entity-media-session');
        const inventoryList = await get(`/api/v1/campaigns/${campaignId}/inventory`);
        const inventoryItem = JSON.parse(inventoryList.payload).items.find(
            (item: { item_name: string }) => item.item_name === artifact.name,
        );
        expect(inventoryItem.image.id).toBe(JSON.parse(artifactUpload.payload).id);
    });

    it('enriches party/session references and atomically replaces, edits, then deletes media', async () => {
        const npc = db.prepare('SELECT id, short_id, name FROM npc_dossier WHERE campaign_id = ?').get(campaignId) as {
            id: number;
            short_id: string;
            name: string;
        };
        const artifact = db.prepare('SELECT id, short_id, name FROM artifacts WHERE campaign_id = ?').get(campaignId) as {
            id: number;
            short_id: string;
            name: string;
        };
        const sessionId = 'entity-media-session';
        sessionRepository.createSession(sessionId, GUILD_ID, campaignId);
        db.prepare(
            `INSERT INTO recordings (
                session_id, filename, filepath, user_id, timestamp, status,
                character_name_snapshot, present_npcs
            ) VALUES (?, ?, ?, ?, ?, 'PROCESSED', ?, ?)`,
        ).run(
            sessionId,
            'entity-media.flac',
            '/tmp/entity-media.flac',
            OWNER_ID,
            Date.now(),
            'The Archivist',
            JSON.stringify([npc.name]),
        );

        const party = await get(`/api/v1/campaigns/${campaignId}/party`);
        const partyMember = JSON.parse(party.payload).members.find(
            (member: { userId: string }) => member.userId === OWNER_ID,
        );
        expect(partyMember.image).not.toBeNull();

        const session = await get(`/api/v1/campaigns/${campaignId}/sessions/${sessionId}`);
        expect(session.statusCode).toBe(200);
        const sessionBody = JSON.parse(session.payload);
        expect(sessionBody.participants[0].image).not.toBeNull();
        expect(sessionBody.npcsEncountered[0].image).not.toBeNull();
        expect(sessionBody.inventory.find((item: { item_name: string }) => item.item_name === artifact.name).image)
            .not.toBeNull();

        const existing = entityMediaRepository.getForEntity(campaignId, 'npc', String(npc.id))!;
        const configuredDriver = config.mediaStorage.driver;
        try {
            config.mediaStorage.driver = 'disabled';
            const disabledRead = await get(`/api/v1/campaigns/${campaignId}/media/${existing.id}/display`);
            expect(disabledRead.statusCode).toBe(503);
            const disabledDelete = await fastify.inject({
                method: 'DELETE',
                url: `/api/v1/campaigns/${campaignId}/npc/${npc.short_id}/image`,
                headers: cookieHeader(managerCookie),
            });
            expect(disabledDelete.statusCode).toBe(503);
            expect(entityMediaRepository.getForEntity(campaignId, 'npc', String(npc.id))?.id).toBe(existing.id);
        } finally {
            config.mediaStorage.driver = configuredDriver;
        }

        // A second upload *adds*. It used to destroy the first one, which is
        // how a generated portrait could quietly delete a picture somebody had
        // chosen and uploaded themselves.
        const replacement = await upload('npc', npc.short_id, managerCookie, png, { altText: 'Replacement' });
        expect(replacement.statusCode).toBe(200);
        const replacementBody = JSON.parse(replacement.payload);
        expect(replacementBody.id).not.toBe(existing.id);
        expect(replacementBody.isPrimary).toBe(false);

        const oldRead = await get(`/api/v1/campaigns/${campaignId}/media/${existing.id}/display`);
        expect(oldRead.statusCode).toBe(200);

        const gallery = await get(`/api/v1/campaigns/${campaignId}/npc/${npc.short_id}/images`);
        expect(JSON.parse(gallery.payload).map((image: { id: string }) => image.id))
            .toEqual([existing.id, replacementBody.id]);

        // Which picture represents an entity is a decision, not a side effect of
        // being the newest.
        const promoted = await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/media/${replacementBody.id}/primary`,
            headers: cookieHeader(managerCookie),
        });
        expect(promoted.statusCode).toBe(201);
        expect(JSON.parse(promoted.payload).isPrimary).toBe(true);
        expect(entityMediaRepository.getForEntity(campaignId, 'npc', String(npc.id))?.id)
            .toBe(replacementBody.id);

        // Removing the main one hands the role on rather than leaving the sheet
        // looking empty while pictures remain.
        const removedOne = await fastify.inject({
            method: 'DELETE',
            url: `/api/v1/campaigns/${campaignId}/media/${replacementBody.id}`,
            headers: cookieHeader(managerCookie),
        });
        expect(removedOne.statusCode).toBe(204);
        expect(entityMediaRepository.getForEntity(campaignId, 'npc', String(npc.id))?.id).toBe(existing.id);

        const restored = await upload('npc', npc.short_id, managerCookie, png, { altText: 'Replacement' });
        const restoredBody = JSON.parse(restored.payload);
        await fastify.inject({
            method: 'POST',
            url: `/api/v1/campaigns/${campaignId}/media/${restoredBody.id}/primary`,
            headers: cookieHeader(managerCookie),
        });
        replacementBody.id = restoredBody.id;

        const updated = await fastify.inject({
            method: 'PATCH',
            url: `/api/v1/campaigns/${campaignId}/media/${replacementBody.id}`,
            headers: {
                ...cookieHeader(managerCookie),
                'content-type': 'application/json',
            },
            payload: JSON.stringify({ focalX: 12, focalY: 88, altText: 'Adjusted portrait' }),
        });
        expect(updated.statusCode).toBe(200);
        expect(JSON.parse(updated.payload)).toMatchObject({
            focalX: 12,
            focalY: 88,
            altText: 'Adjusted portrait',
        });

        const deleted = await fastify.inject({
            method: 'DELETE',
            url: `/api/v1/campaigns/${campaignId}/npc/${npc.short_id}/image`,
            headers: cookieHeader(managerCookie),
        });
        expect(deleted.statusCode).toBe(204);
        expect(entityMediaRepository.getForEntity(campaignId, 'npc', String(npc.id))).toBeNull();

        const detailAfterDelete = await get(`/api/v1/campaigns/${campaignId}/npcs/${npc.short_id}`);
        expect(JSON.parse(detailAfterDelete.payload).image).toBeNull();
    });
});
