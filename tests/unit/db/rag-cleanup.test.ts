/**
 * Regression test for the case-insensitive RAG cleanup bug.
 *
 * Before the fix, `deleteArtifactRagSummary` (and siblings) used `content LIKE
 * '%: <name>]]%'` — SQLite's LIKE is case-insensitive for ASCII, so dropping
 * the loser's card "Corona di Spine" ALSO deleted the survivor's cards
 * "Corona di spine" (a case variant). On the real DB this wiped all 10
 * ARTIFACT_UPDATE cards of Corona instead of the loser's 2.
 *
 * Fix: `INSTR(content, ?) > 0` with a literal substring — case-sensitive.
 * This test verifies that the card with the exact name is dropped and the
 * survivor's case variant survives.
 */
import {
    initDatabase,
    createCampaign,
    deleteCampaign,
    knowledgeRepository,
    insertKnowledgeFragment,
    getKnowledgeFragments,
} from '../../../src/db';

const EMBED = 'test-rag-cleanup-model';

function artifactSchedaFragments(campaignId: number) {
    return getKnowledgeFragments(campaignId, EMBED).filter((f: any) => f.session_id === 'ARTIFACT_UPDATE');
}
function hasScheda(frags: any[], name: string): boolean {
    return frags.some((f) => f.content.includes(`: ${name}]]`));
}

describe('RAG cleanup case-sensitivity (INSTR, no over-delete)', () => {
    let campaignId: number;

    beforeAll(() => {
        initDatabase();
        campaignId = createCampaign('Test RAG cleanup', 'test-guild-rag-cleanup');
    });

    afterAll(() => {
        try { deleteCampaign(campaignId); } catch { /* */ }
    });

    test('deleteArtifactRagSummary drops only the record of the exact name (case-sensitive)', () => {
        insertKnowledgeFragment(campaignId, 'ARTIFACT_UPDATE', '[[SCHEDA ARTEFATTO UFFICIALE: Corona di Spine]]\nDESCRIZIONE: loser', [0.1, 0.2], EMBED);
        insertKnowledgeFragment(campaignId, 'ARTIFACT_UPDATE', '[[SCHEDA ARTEFATTO UFFICIALE: Corona di spine]]\nDESCRIZIONE: survivor', [0.3, 0.4], EMBED);

        // both present beforehand
        const before = artifactSchedaFragments(campaignId);
        expect(hasScheda(before, 'Corona di Spine')).toBe(true);
        expect(hasScheda(before, 'Corona di spine')).toBe(true);

        // delete del loser (capital S)
        knowledgeRepository.deleteArtifactRagSummary(campaignId, 'Corona di Spine');

        const after = artifactSchedaFragments(campaignId);
        // loser droppato
        expect(hasScheda(after, 'Corona di Spine')).toBe(false);
        // SURVIVOR kept — before the fix, case-insensitive LIKE deleted it
        expect(hasScheda(after, 'Corona di spine')).toBe(true);
    });

    test('deleteQuestRagSummary è case-sensitive (no over-delete)', () => {
        insertKnowledgeFragment(campaignId, 'QUEST_UPDATE', '[[SCHEDA QUEST UFFICIALE: La Caccia]]\nOBIETTIVO: loser', [0.1], EMBED);
        insertKnowledgeFragment(campaignId, 'QUEST_UPDATE', '[[SCHEDA QUEST UFFICIALE: la caccia]]\nOBIETTIVO: survivor', [0.2], EMBED);

        knowledgeRepository.deleteQuestRagSummary(campaignId, 'La Caccia');

        const after = getKnowledgeFragments(campaignId, EMBED).filter((f: any) => f.session_id === 'QUEST_UPDATE');
        expect(hasScheda(after, 'La Caccia')).toBe(false);
        expect(hasScheda(after, 'la caccia')).toBe(true);
    });

    test('prepare + replace keeps the earlier versions in a single timeline', () => {
        const header = '[[SCHEDA ARTEFATTO UFFICIALE: Sigillo del Sole]]';
        insertKnowledgeFragment(
            campaignId,
            'ARTIFACT_UPDATE',
            `${header}\nDESCRIZIONE: prima versione`,
            [0.1],
            EMBED,
            100,
        );
        insertKnowledgeFragment(
            campaignId,
            'ARTIFACT_UPDATE',
            `${header}\nDESCRIZIONE: seconda versione`,
            [0.2],
            EMBED,
            200,
        );

        const content = knowledgeRepository.prepareEntityRagSnapshotContent(
            campaignId,
            'ARTIFACT_UPDATE',
            header,
            `${header}\nDESCRIZIONE: versione canonica`,
            300,
        );
        const replaced = knowledgeRepository.replaceEntityRagSnapshot(
            campaignId,
            'ARTIFACT_UPDATE',
            header,
            content,
            [0.3],
            EMBED,
            300,
        );

        const matching = artifactSchedaFragments(campaignId)
            .filter((fragment: any) => fragment.content.startsWith(header));
        expect(replaced).toBe(2);
        expect(matching).toHaveLength(1);
        expect(matching[0].content).toContain('STATO ATTUALE\nDESCRIZIONE: versione canonica');
        expect(matching[0].content).toContain('DESCRIZIONE: prima versione');
        expect(matching[0].content).toContain('DESCRIZIONE: seconda versione');
        expect(matching[0].content).toContain('versione canonica');
        expect(matching[0].content.match(/--- SNAPSHOT @/g)).toHaveLength(3);
    });

    test('mergeEntityRagSnapshots keeps both loser and survivor history in one fragment', () => {
        const source = '[[SCHEDA ARTEFATTO UFFICIALE: Sigillo antico]]';
        const target = '[[SCHEDA ARTEFATTO UFFICIALE: Sigillo Antico]]';
        insertKnowledgeFragment(
            campaignId,
            'ARTIFACT_UPDATE',
            `${source}\nPOSSESSORE: Arven`,
            [0.1],
            EMBED,
            100,
        );
        insertKnowledgeFragment(
            campaignId,
            'ARTIFACT_UPDATE',
            `${target}\nPOSSESSORE: Mira`,
            [0.2],
            EMBED,
            200,
        );

        expect(knowledgeRepository.mergeEntityRagSnapshots(
            campaignId,
            'ARTIFACT_UPDATE',
            source,
            target,
        )).toBe(1);

        const matching = artifactSchedaFragments(campaignId)
            .filter((fragment: any) => fragment.content.startsWith(target));
        expect(matching).toHaveLength(1);
        expect(matching[0].content).toContain('STATO ATTUALE\nPOSSESSORE: Mira');
        expect(matching[0].content).toContain('--- SNAPSHOT @100 ---\nPOSSESSORE: Arven');
        expect(matching[0].content).toContain('--- SNAPSHOT @200 ---\nPOSSESSORE: Mira');
        expect(artifactSchedaFragments(campaignId).some(
            (fragment: any) => fragment.content.startsWith(source),
        )).toBe(false);
    });
});
