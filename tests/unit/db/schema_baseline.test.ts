/**
 * Invariants of the baseline schema.
 *
 * The schema no longer has a migration history: it is a single snapshot that
 * `initDatabase()` applies idempotently. So the class of tests that
 * re-ran a single migration by rewinding `user_version` disappears, and
 * what remains is what those migrations had produced — which is the thing that really
 * matters not to lose in a rebuild or in a fresh installation.
 */

import { db, initDatabase } from '../../../src/db';
import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { bestiaryRepository } from '../../../src/db/repositories/BestiaryRepository';

function columnNames(table: string): string[] {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name);
}

function ddlOf(name: string): string {
    const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string } | undefined;
    return row?.sql ?? '';
}

describe('Schema baseline', () => {
    beforeAll(() => {
        wipeDatabase();
    });

    afterAll(() => {
        wipeDatabase();
    });

    it('è idempotente: rieseguire initDatabase non cambia nulla e non lancia', () => {
        const before = db.prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        ).all();

        expect(() => initDatabase()).not.toThrow();

        const after = db.prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        ).all();
        expect(after).toEqual(before);
    });

    it('parte da user_version 0: non esiste alcuna migrazione da applicare', () => {
        expect(db.pragma('user_version', { simple: true })).toBe(0);
    });

    it('no longer carries the legacy bestiary.count column', () => {
        expect(columnNames('bestiary')).not.toContain('count');

        const campaignId = campaignRepository.createCampaign('guild-bestiary-fresh', 'Fresh Bestiary');
        bestiaryRepository.upsertMonster(campaignId, 'Goblin', 'ALIVE', 'session-fresh');

        const monster = bestiaryRepository.getMonsterByName(campaignId, 'Goblin');
        expect(monster).toMatchObject({ name: 'Goblin', status: 'ALIVE', session_id: 'session-fresh' });
        expect(monster).not.toHaveProperty('count');
    });

    it('applica COLLATE NOCASE all\'unicità di artifacts e npc_dossier', () => {
        // Without NOCASE, "Corona di Spine" and "Corona di spine" would be two distinct
        // entities, and the AI would generate a new one at every change of case.
        for (const table of ['artifacts', 'npc_dossier']) {
            expect(ddlOf(table)).toMatch(/NOCASE/i);
        }
    });

    it('rejects an artifact name that differs only by case', () => {
        const campaignId = campaignRepository.createCampaign('guild-nocase', 'NOCASE Campaign');
        const insert = db.prepare('INSERT INTO artifacts (campaign_id, name, description) VALUES (?, ?, ?)');
        insert.run(campaignId, 'Corona di Spine', 'La prima');

        expect(() => insert.run(campaignId, 'corona di spine', 'La stessa, in minuscolo'))
            .toThrow(/UNIQUE/i);
    });

    it('protegge quests da stati e tipi non validi tramite trigger', () => {
        // SQLite does not allow adding a CHECK to an existing table:
        // these constraints live as BEFORE INSERT/UPDATE triggers.
        const campaignId = campaignRepository.createCampaign('guild-quests', 'Quest Campaign');
        const insert = db.prepare('INSERT INTO quests (campaign_id, title, status, type) VALUES (?, ?, ?, ?)');

        expect(() => insert.run(campaignId, 'Valida', 'OPEN', 'MAJOR')).not.toThrow();
        expect(() => insert.run(campaignId, 'Stato assurdo', 'BANANA', 'MAJOR')).toThrow(/invalid quest/i);
        expect(() => insert.run(campaignId, 'Tipo assurdo', 'OPEN', 'BANANA')).toThrow(/invalid quest/i);
    });

    it('non contiene alcuna tabella di fatturazione', () => {
        const tables = (db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).all() as Array<{ name: string }>).map(r => r.name);

        for (const name of tables) {
            expect(name).not.toMatch(/credit|stripe|payment|billing/i);
        }
    });

    it('recovers the embedding model of already indexed campaigns', () => {
        // The migration case: the column is born empty on a database that
        // already has fragments. Leaving it that way would make the campaign look «not
        // pinned yet», and at the first indexing the resolver would pick
        // a different model, making the existing vectors invisible at a stroke.
        db.prepare('DELETE FROM knowledge_fragments').run();
        const campaignId = campaignRepository.createCampaign('gilda-backfill', 'Vecchia campagna');
        db.prepare('UPDATE campaigns SET embedding_model = NULL, embedding_dimension = NULL WHERE id = ?')
            .run(campaignId);
        db.prepare(`
            INSERT INTO knowledge_fragments (campaign_id, content, embedding_json, embedding_model, vector_dimension)
            VALUES (?, 'un ricordo', '[0.1]', 'nomic-embed-text', 768)
        `).run(campaignId);

        initDatabase();

        const campaign = db.prepare('SELECT embedding_model, embedding_dimension FROM campaigns WHERE id = ?')
            .get(campaignId) as { embedding_model: string; embedding_dimension: number };
        expect(campaign.embedding_model).toBe('nomic-embed-text');
        expect(campaign.embedding_dimension).toBe(768);
    });

    it('does not invent a model for a campaign that never indexed anything', () => {
        const campaignId = campaignRepository.createCampaign('gilda-vuota', 'Campagna nuova');
        initDatabase();

        const campaign = db.prepare('SELECT embedding_model FROM campaigns WHERE id = ?')
            .get(campaignId) as { embedding_model: string | null };
        // It stays free to choose at the first indexing, according to what
        // that table really has: its own hardware or its own key.
        expect(campaign.embedding_model).toBeNull();
    });
});
