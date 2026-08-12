/**
 * findNpcDossierByName has to check whether the QUESTION contains the NPC's
 * name/alias, not the other way round. The original SQL query did
 * `name LIKE '%' || query || '%'`: a short name ("Helena") can never
 * contain a whole question as a substring, so it NEVER found
 * anything when called (as askBard always does) with the user's entire
 * question as the query. See askBard in src/bard/rag/search.ts.
 */
import { campaignRepository } from '../../../src/db/repositories/CampaignRepository';
import { npcRepository } from '../../../src/db/repositories/NpcRepository';
import { db } from '../../../src/db';

const GUILD = 'test_guild_npc_dossier_lookup';
let campaignId: number;

describe('findNpcDossierByName', () => {
    beforeAll(() => {
        campaignId = campaignRepository.createCampaign(GUILD, 'NPC Dossier Lookup Campaign');
        npcRepository.updateNpcEntry(campaignId, 'Helena', 'Guida che ha tradito il party', 'Guida', 'MISSING', 'sess-1');
        npcRepository.updateNpcEntry(campaignId, 'Trillo', 'Un famiglio timoroso', 'Familiare', 'ALIVE', 'sess-1');
    });

    afterAll(() => {
        db.prepare('DELETE FROM npc_dossier WHERE campaign_id = ?').run(campaignId);
        db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
    });

    it('finds the NPC when its name appears inside a full question (a real askBard case)', () => {
        const results = npcRepository.findNpcDossierByName(campaignId, 'chi è helena?');
        expect(results.map((r: any) => r.name)).toContain('Helena');
    });

    it('è case-insensitive', () => {
        const results = npcRepository.findNpcDossierByName(campaignId, 'CHI È HELENA?');
        expect(results.map((r: any) => r.name)).toContain('Helena');
    });

    it('finds the NPC inside a longer question that does not name it up front', () => {
        const results = npcRepository.findNpcDossierByName(campaignId, 'Raccontami tutto quello che sai su Helena e il suo tradimento');
        expect(results.map((r: any) => r.name)).toContain('Helena');
    });

    it('finds nothing when no NPC is named in the question', () => {
        const results = npcRepository.findNpcDossierByName(campaignId, 'che tempo fa a Pestum?');
        expect(results).toHaveLength(0);
    });

    it('does not confuse different NPCs (Trillo must not surface when asking about Helena)', () => {
        const results = npcRepository.findNpcDossierByName(campaignId, 'ha tradito il party Helena?');
        const names = results.map((r: any) => r.name);
        expect(names).toContain('Helena');
        expect(names).not.toContain('Trillo');
    });

    it('finds several NPCs when both are named in the same question', () => {
        const results = npcRepository.findNpcDossierByName(campaignId, 'Che rapporto c\'è tra Helena e Trillo?');
        const names = results.map((r: any) => r.name);
        expect(names).toContain('Helena');
        expect(names).toContain('Trillo');
    });
});
