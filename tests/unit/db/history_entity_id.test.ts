/**
 * History phase 2: id-first reads with a name fallback.
 *
 * Invariants:
 *  - rows linked via entity_id follow the entity after a rename/merge;
 *  - legacy rows (entity_id NULL) stay readable by name;
 *  - NULL rows with ANOTHER name are not included;
 *  - merges leave no rows pointing at deleted ids;
 *  - updateFactionAlignmentScore writes entity_id (it used to stay NULL).
 */

import { wipeDatabase } from '../../../src/db/maintenance';
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { factionRepository } from '../../../src/db/repositories/FactionRepository';
import { inventoryRepository } from '../../../src/db/repositories/InventoryRepository';
import { db } from '../../../src/db';

const GUILD = 'test_history_entity_id';
let campaignId: number;
const SESSION = 'sess-hist-1';

beforeAll(() => {
    wipeDatabase();
    campaignId = campaignRepository.createCampaign('History EntityId Campaign', GUILD);
});

describe('getNpcHistory id-first + fallback', () => {
    test('reads id-linked rows and legacy NULL rows by name; excludes NULLs under other names', () => {
        npcRepository.updateNpcEntry(campaignId, 'Gandalf', 'Mago', undefined, undefined, SESSION);
        npcRepository.addNpcEvent(campaignId, 'Gandalf', SESSION, 'Evento con id', 'EVENT');

        // Legacy row: same entity but without entity_id
        db.prepare(`
            INSERT INTO npc_history (campaign_id, npc_name, session_id, description, event_type, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(campaignId, 'gandalf', SESSION, 'Evento legacy senza id', 'EVENT', Date.now());

        // A NULL row of ANOTHER npc: it must not appear
        db.prepare(`
            INSERT INTO npc_history (campaign_id, npc_name, session_id, description, event_type, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(campaignId, 'Saruman', SESSION, 'Evento di altro NPC', 'EVENT', Date.now());

        const history = npcRepository.getNpcHistory(campaignId, 'Gandalf');
        const descriptions = history.map((h: any) => h.description);
        expect(descriptions).toContain('Evento con id');
        expect(descriptions).toContain('Evento legacy senza id');
        expect(descriptions).not.toContain('Evento di altro NPC');
    });

    test('case-insensitive read (getNpcHistory used to be case-sensitive)', () => {
        const history = npcRepository.getNpcHistory(campaignId, 'GANDALF');
        expect(history.length).toBeGreaterThanOrEqual(2);
    });

    test('plain rename: the history follows the new name, legacy rows included', () => {
        npcRepository.renameNpcEntry(campaignId, 'Gandalf', 'Mithrandir');
        const history = npcRepository.getNpcHistory(campaignId, 'Mithrandir');
        const descriptions = history.map((h: any) => h.description);
        expect(descriptions).toContain('Evento con id');
        expect(descriptions).toContain('Evento legacy senza id');

        // No row with a NULL entity_id is left for this npc
        const npc = npcRepository.getNpcEntry(campaignId, 'Mithrandir')!;
        const nulls = db.prepare(
            `SELECT COUNT(*) c FROM npc_history WHERE campaign_id = ? AND lower(npc_name) = lower(?) AND entity_id IS NULL`
        ).get(campaignId, 'Mithrandir') as { c: number };
        expect(nulls.c).toBe(0);
        expect(npc.id).toBeDefined();
    });

    test('merge: the source\'s history follows the target, no dangling ids', () => {
        npcRepository.updateNpcEntry(campaignId, 'Grigio', 'Duplicato del mago', undefined, undefined, SESSION);
        const sourceId = npcRepository.getNpcEntry(campaignId, 'Grigio')!.id;
        npcRepository.addNpcEvent(campaignId, 'Grigio', SESSION, 'Evento della source', 'EVENT');

        // Merge: "Grigio" → "Mithrandir" (esiste già → ramo merge)
        npcRepository.renameNpcEntry(campaignId, 'Grigio', 'Mithrandir');

        const history = npcRepository.getNpcHistory(campaignId, 'Mithrandir');
        expect(history.map((h: any) => h.description)).toContain('Evento della source');

        // No row points at the deleted dossier's id
        const dangling = db.prepare(
            `SELECT COUNT(*) c FROM npc_history WHERE campaign_id = ? AND entity_id = ?`
        ).get(campaignId, sourceId) as { c: number };
        expect(dangling.c).toBe(0);
    });
});

describe('an inventory merge moves the history (it used to be orphaned)', () => {
    test('item merge: the events are reachable from the target name', () => {
        inventoryRepository.addLoot(campaignId, 'Pozione Rossa', 1, SESSION);
        inventoryRepository.addInventoryEvent(campaignId, 'Pozione Rossa', SESSION, 'Trovata nel dungeon', 'FOUND');
        inventoryRepository.addLoot(campaignId, 'Pozione di Cura', 1, SESSION);

        inventoryRepository.mergeInventoryItems(campaignId, 'Pozione Rossa', 'Pozione di Cura');

        const history = inventoryRepository.getInventoryHistory(campaignId, 'Pozione di Cura');
        expect(history.map((h: any) => h.description)).toContain('Trovata nel dungeon');

        // The history of the old "Pozione Rossa" no longer exists under that name
        const old = db.prepare(
            `SELECT COUNT(*) c FROM inventory_history WHERE campaign_id = ? AND lower(item_name) = lower(?)`
        ).get(campaignId, 'Pozione Rossa') as { c: number };
        expect(old.c).toBe(0);
    });
});

describe('faction: updateFactionAlignmentScore writes entity_id', () => {
    test('the member\'s contribution is id-linked and still counts after a rename', () => {
        factionRepository.createFaction(campaignId, 'Compagnia', { description: 'Fazione di test' });
        const faction = factionRepository.getFaction(campaignId, 'Compagnia')!;

        factionRepository.updateFactionAlignmentScore(campaignId, faction.id, 5, 0);

        const row = db.prepare(
            `SELECT entity_id FROM faction_history WHERE campaign_id = ? AND description = 'Contributo membro'`
        ).get(campaignId) as { entity_id: number | null };
        expect(row.entity_id).toBe(faction.id);

        // After the rename the history stays linked and readable under the new name
        factionRepository.renameFaction(campaignId, 'Compagnia', 'Compagnia dell Anello');
        const history = factionRepository.getFactionHistory(campaignId, 'Compagnia dell Anello');
        expect(history.map((h: any) => h.description)).toContain('Contributo membro');
    });
});
