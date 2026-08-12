/**
 * Manual data protection invariant: an entity marked is_manual=1
 * must not lose the flag nor the manual_description when an
 * AI update (isManual=false) arrives. See CLAUDE.md "Manual data protection".
 */
import {
    initDatabase,
    createCampaign,
    deleteCampaign
} from '../../../src/db';
import { questRepository } from '../../../src/db/repositories/QuestRepository';
import { artifactRepository } from '../../../src/db/repositories/ArtifactRepository';

describe('Protezione dati manuali (is_manual)', () => {
    let campaignId: number;

    beforeAll(() => {
        campaignId = createCampaign('Test Manual Protection', 'test-guild');
    });

    afterAll(() => {
        try { deleteCampaign(campaignId); } catch { }
    });

    test('an AI upsert neither clears is_manual nor wipes manual_description (quest)', () => {
        questRepository.addQuest(campaignId, 'La Piaga di Ferro', 'sess-1', 'Descrizione manuale del DM', undefined, undefined, true);
        const manual = questRepository.getOpenQuests(campaignId).find(q => q.title === 'La Piaga di Ferro') as any;
        expect(manual.is_manual).toBe(1);

        // An "AI" update (isManual=false) on the same quest
        questRepository.addQuest(campaignId, 'La Piaga di Ferro', 'sess-2', 'Descrizione generata dalla AI', undefined, undefined, false);
        const after = questRepository.getOpenQuests(campaignId).find(q => q.title === 'La Piaga di Ferro') as any;

        expect(after.is_manual).toBe(1);
        expect(after.manual_description).toBe('Descrizione manuale del DM');
    });

    test('an AI upsert neither clears is_manual nor wipes manual_description (artifact)', () => {
        artifactRepository.upsertArtifact(campaignId, 'Spada del Vespro', 'FUNCTIONAL', 'sess-1', { description: 'Forgiata dal DM' }, true);
        artifactRepository.upsertArtifact(campaignId, 'Spada del Vespro', 'FUNCTIONAL', 'sess-2', { description: 'Riscritta dalla AI' }, false);

        const after = artifactRepository.getArtifactByName(campaignId, 'Spada del Vespro') as any;
        expect(after.is_manual).toBe(1);
        expect(after.manual_description).toBe('Forgiata dal DM');
    });
});
