/**
 * An entity holds several pictures, and the migration that made that possible.
 *
 * The rebuild is the only migration in this project that rewrites a table
 * rather than adding a column — SQLite cannot drop `UNIQUE(...)` any other way —
 * so it is tested against a database shaped exactly like the old one, with rows
 * in it, and the assertion that matters is that nothing was lost.
 */
import Database from 'better-sqlite3';
import { createCampaign, deleteCampaign } from '../../../src/db';
import { entityMediaRepository } from '../../../src/db/repositories/EntityMediaRepository';

describe('entity media gallery', () => {
    let campaignId: number;

    beforeAll(() => {
        campaignId = createCampaign('Test Gallery', 'test-guild');
    });

    afterAll(() => {
        try { deleteCampaign(campaignId); } catch { /* already gone */ }
    });

    const picture = (id: string, key = 'npc-1') => ({
        id,
        campaign_id: campaignId,
        entity_type: 'npc' as const,
        entity_key: key,
        display_object_key: `media/${id}/display.webp`,
        thumbnail_object_key: `media/${id}/thumbnail.webp`,
        width: 800,
        height: 1000,
        size_bytes: 1234,
        focal_x: 50,
        focal_y: 50,
        alt_text: null,
        source: 'upload' as const,
        generation_mode: null,
        generation_prompt: null,
        generation_user_prompt: null,
        uploaded_by: 'someone',
    });

    test('the first picture is the main one and later ones are not promoted', () => {
        entityMediaRepository.add(picture('a'));
        entityMediaRepository.add(picture('b'));

        const gallery = entityMediaRepository.listForEntity(campaignId, 'npc', 'npc-1');
        expect(gallery.map(row => row.id)).toEqual(['a', 'b']);
        // The point of the change: a second picture adds, it does not destroy
        // the first, and it does not take over the sheet by being newest.
        expect(gallery[0].is_primary).toBe(1);
        expect(gallery[1].is_primary).toBe(0);
        expect(entityMediaRepository.getForEntity(campaignId, 'npc', 'npc-1')?.id).toBe('a');
    });

    test('promoting one demotes the other', () => {
        entityMediaRepository.setPrimary(campaignId, 'b');

        expect(entityMediaRepository.getForEntity(campaignId, 'npc', 'npc-1')?.id).toBe('b');
        expect(entityMediaRepository.getById(campaignId, 'a')?.is_primary).toBe(0);
    });

    test('removing the main one hands the role on', () => {
        entityMediaRepository.deleteById(campaignId, 'b');

        // An entity left with pictures but no main one would render as if it
        // had none at all.
        expect(entityMediaRepository.getForEntity(campaignId, 'npc', 'npc-1')?.id).toBe('a');
        expect(entityMediaRepository.getById(campaignId, 'a')?.is_primary).toBe(1);
    });

    test('lists and cards still see exactly one picture per entity', () => {
        entityMediaRepository.add(picture('c'));

        const resolved = entityMediaRepository.getForEntities(campaignId, [
            { entityType: 'npc', entityKey: 'npc-1' },
        ]);
        expect(resolved.size).toBe(1);
        expect([...resolved.values()][0].id).toBe('a');
    });

    test('deleting an entity returns every picture, so no object is orphaned', () => {
        const removed = entityMediaRepository.deleteForEntity(campaignId, 'npc', 'npc-1');

        expect(removed.map(row => row.id).sort()).toEqual(['a', 'c']);
        expect(entityMediaRepository.listForEntity(campaignId, 'npc', 'npc-1')).toEqual([]);
    });
});

describe('the migration off the one-picture-per-entity constraint', () => {
    /**
     * Builds a database exactly as it existed before this change: the old
     * `entity_media` with its UNIQUE, and a row in it.
     */
    function legacyDatabase(): Database.Database {
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE campaigns (id INTEGER PRIMARY KEY, guild_id TEXT, name TEXT)`);
        db.exec(`CREATE TABLE entity_media (
            id TEXT PRIMARY KEY,
            campaign_id INTEGER NOT NULL,
            entity_type TEXT NOT NULL CHECK(entity_type IN ('npc', 'location', 'character', 'artifact')),
            entity_key TEXT NOT NULL,
            display_object_key TEXT NOT NULL,
            thumbnail_object_key TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL,
            focal_x REAL NOT NULL DEFAULT 50,
            focal_y REAL NOT NULL DEFAULT 50,
            alt_text TEXT,
            source TEXT NOT NULL DEFAULT 'upload',
            generation_mode TEXT,
            generation_prompt TEXT,
            generation_user_prompt TEXT,
            uploaded_by TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(campaign_id, entity_type, entity_key),
            FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
        )`);
        db.prepare('INSERT INTO campaigns (id, guild_id, name) VALUES (1, ?, ?)').run('g', 'Tavolo');
        db.prepare(`INSERT INTO entity_media (
            id, campaign_id, entity_type, entity_key, display_object_key, thumbnail_object_key,
            width, height, size_bytes, alt_text, uploaded_by, created_at, updated_at
        ) VALUES ('kept', 1, 'npc', '7', 'd.webp', 't.webp', 800, 1000, 10, 'A portrait', 'someone', 5, 5)`).run();
        return db;
    }

    /** The migration, as `schema.ts` performs it, against a given database. */
    function migrate(db: Database.Database): void {
        const table = db.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entity_media'",
        ).get() as { sql: string } | undefined;
        if (!table?.sql || !/UNIQUE\s*\(\s*campaign_id/i.test(table.sql)) return;

        const columns = (db.prepare('PRAGMA table_info(entity_media)').all() as Array<{ name: string }>)
            .map(column => column.name)
            .filter(name => name !== 'is_primary');
        const columnList = columns.map(name => `"${name}"`).join(', ');

        db.pragma('foreign_keys = OFF');
        db.transaction(() => {
            db.exec(`CREATE TABLE entity_media__gallery (
                id TEXT PRIMARY KEY,
                campaign_id INTEGER NOT NULL,
                entity_type TEXT NOT NULL,
                entity_key TEXT NOT NULL,
                display_object_key TEXT NOT NULL,
                thumbnail_object_key TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                size_bytes INTEGER NOT NULL,
                focal_x REAL NOT NULL DEFAULT 50,
                focal_y REAL NOT NULL DEFAULT 50,
                alt_text TEXT,
                source TEXT NOT NULL DEFAULT 'upload',
                generation_mode TEXT,
                generation_prompt TEXT,
                generation_user_prompt TEXT,
                is_primary INTEGER NOT NULL DEFAULT 1,
                uploaded_by TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )`);
            db.exec(
                `INSERT INTO entity_media__gallery (${columnList}, is_primary) ` +
                `SELECT ${columnList}, 1 FROM entity_media`,
            );
            db.exec('DROP TABLE entity_media');
            db.exec('ALTER TABLE entity_media__gallery RENAME TO entity_media');
        })();
        db.pragma('foreign_keys = ON');
    }

    test('keeps every existing picture, as its entity\'s main one', () => {
        const db = legacyDatabase();
        migrate(db);

        const rows = db.prepare('SELECT * FROM entity_media').all() as any[];
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('kept');
        expect(rows[0].alt_text).toBe('A portrait');
        expect(rows[0].is_primary).toBe(1);
        db.close();
    });

    test('a second picture becomes possible, which is the whole point', () => {
        const db = legacyDatabase();
        migrate(db);

        expect(() => db.prepare(`INSERT INTO entity_media (
            id, campaign_id, entity_type, entity_key, display_object_key, thumbnail_object_key,
            width, height, size_bytes, is_primary, uploaded_by, created_at, updated_at
        ) VALUES ('second', 1, 'npc', '7', 'd2.webp', 't2.webp', 800, 1000, 10, 0, 'someone', 6, 6)`).run())
            .not.toThrow();
        db.close();
    });

    test('running twice changes nothing the second time', () => {
        const db = legacyDatabase();
        migrate(db);
        const after = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entity_media'").get() as { sql: string };

        migrate(db);

        expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'entity_media'").get() as { sql: string }).sql)
            .toBe(after.sql);
        expect(db.prepare('SELECT COUNT(*) n FROM entity_media').get()).toEqual({ n: 1 });
        db.close();
    });
});
