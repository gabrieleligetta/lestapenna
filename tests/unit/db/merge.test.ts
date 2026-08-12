/**
 * Entity merge tests (artifacts + NPCs): verifies that the merge
 *   1. leaves a single survivor,
 *   2. repoints the history,
 *   3. unifies the *_UPDATE RAG cards into one canonical timeline,
 *   4. rewrites the inventory RAG refs for artifacts,
 *   5. regenerates the survivor's short_id on a collision,
 *   6. propagates is_manual/manual_description from the loser.
 */
import {
    initDatabase,
    createCampaign,
    deleteCampaign,
    artifactRepository,
    insertKnowledgeFragment,
    getKnowledgeFragments,
    updateNpcEntry,
    getNpcEntry,
    addNpcEvent,
    factionRepository,
} from '../../../src/db';
import { db } from '../../../src/db/client';
import { mergeNpcsByName, mergeArtifactsByName } from '../../../src/bard/reconciliation/merge';

const EMBED_MODEL = 'test-merge-model';

describe('Merge entità (DB + RAG)', () => {
    let campaignId: number;

    beforeAll(() => {
        initDatabase();
        campaignId = createCampaign('Test Merge', 'test-guild-merge');
    });

    afterAll(() => {
        try { deleteCampaign(campaignId); } catch { /* */ }
    });

    test('artifact merge: 1 survivor, history ripuntata, RAG loser eliminato, ref inventario riscritti', () => {
        artifactRepository.upsertArtifact(campaignId, 'Corona del Re', 'FUNCTIONAL', 's1', { description: 'Bio A', effects: 'Effetti A' });
        artifactRepository.upsertArtifact(campaignId, 'Corona della Regina', 'FUNCTIONAL', 's2', { description: 'Bio B', effects: 'Effetti B' });

        const a = artifactRepository.getArtifactByName(campaignId, 'Corona del Re')!;
        const b = artifactRepository.getArtifactByName(campaignId, 'Corona della Regina')!;
        artifactRepository.addArtifactEvent(campaignId, 'Corona della Regina', 'sess-x', 'Scoperta nella cripta', 'DISCOVERY');

        // The loser's RAG card + the inventory ref that links the loser.
        insertKnowledgeFragment(campaignId, 'ARTIFACT_UPDATE', '[[SCHEDA ARTEFATTO UFFICIALE: Corona della Regina]]\nDESCRIZIONE: Bio B', [0.1, 0.2, 0.3], EMBED_MODEL);
        insertKnowledgeFragment(campaignId, 'INVENTORY_UPDATE', '[[SCHEDA INVENTARIO: Casco]]\nVedi [[SCHEDA ARTEFATTO UFFICIALE: Corona della Regina]]', [0.4, 0.5, 0.6], EMBED_MODEL);

        const ok = mergeArtifactsByName(campaignId, 'Corona della Regina', 'Corona del Re', 'Bio merged');
        expect(ok).toBe(true);

        // 1 survivor
        expect(artifactRepository.getArtifactByName(campaignId, 'Corona della Regina')).toBeFalsy();
        const survivor = artifactRepository.getArtifactByName(campaignId, 'Corona del Re')!;
        expect(survivor.description).toBe('Bio merged');

        // history repointed onto the survivor
        const hist = artifactRepository.getArtifactHistory(campaignId, 'Corona del Re');
        expect(hist.some((h: any) => h.description.includes('Scoperta nella cripta'))).toBe(true);

        // the loser's RAG card deleted
        const frags = getKnowledgeFragments(campaignId, EMBED_MODEL).filter((f: any) => f.session_id === 'ARTIFACT_UPDATE');
        expect(frags.some((f: any) => f.content.includes('Corona della Regina'))).toBe(false);

        // ref inventario riscritto al survivor
        const inv = getKnowledgeFragments(campaignId, EMBED_MODEL).filter((f: any) => f.session_id === 'INVENTORY_UPDATE');
        expect(inv.some((f: any) => f.content.includes('SCHEDA ARTEFATTO UFFICIALE: Corona del Re'))).toBe(true);
        expect(inv.some((f: any) => f.content.includes('Corona della Regina'))).toBe(false);
    });

    test('artifact merge: short_id rigenerato su collisione', () => {
        artifactRepository.upsertArtifact(campaignId, 'Amuleto A', 'FUNCTIONAL', 's1', { description: 'A' });
        artifactRepository.upsertArtifact(campaignId, 'Amuleto B', 'FUNCTIONAL', 's2', { description: 'B' });
        const a = artifactRepository.getArtifactByName(campaignId, 'Amuleto A')!;
        const b = artifactRepository.getArtifactByName(campaignId, 'Amuleto B')!;
        // forzo la collisione di short_id
        db.prepare('UPDATE artifacts SET short_id = ? WHERE id = ?').run('collid', a.id);
        db.prepare('UPDATE artifacts SET short_id = ? WHERE id = ?').run('collid', b.id);

        const ok = mergeArtifactsByName(campaignId, 'Amuleto B', 'Amuleto A');
        expect(ok).toBe(true);
        const survivor = artifactRepository.getArtifactByName(campaignId, 'Amuleto A')!;
        expect(survivor.short_id).not.toBe('collid');
        expect(survivor.short_id).toBeTruthy();
    });

    test('legacy history: falls back to the name when entity_id wrongly points at the duplicate', () => {
        artifactRepository.upsertArtifact(campaignId, 'Reliquia legacy', 'FUNCTIONAL');
        artifactRepository.upsertArtifact(campaignId, 'Reliquia legacy (duplicato)', 'FUNCTIONAL');
        const duplicate = artifactRepository.getArtifactByName(
            campaignId,
            'Reliquia legacy (duplicato)',
        )!;
        artifactRepository.addArtifactEvent(
            campaignId,
            'Reliquia legacy',
            'sess-legacy',
            'Evento con id backfill errato',
            'UPDATE',
        );
        db.prepare(`
            UPDATE artifact_history
            SET entity_id = ?
            WHERE campaign_id = ? AND artifact_name = ?
        `).run(duplicate.id, campaignId, 'Reliquia legacy');

        const history = artifactRepository.getArtifactHistory(
            campaignId,
            'Reliquia legacy',
        );
        expect(history).toHaveLength(1);
        expect(history[0].description).toBe('Evento con id backfill errato');
    });

    test('artifact merge: carries is_manual + manual_description over from the loser', () => {
        artifactRepository.upsertArtifact(campaignId, 'Reliquia A', 'FUNCTIONAL', 's1', { description: 'AI A' }, false);
        artifactRepository.upsertArtifact(campaignId, 'Reliquia B', 'FUNCTIONAL', 's2', { description: 'Manuale B' }, true);
        mergeArtifactsByName(campaignId, 'Reliquia B', 'Reliquia A');
        const survivor = artifactRepository.getArtifactByName(campaignId, 'Reliquia A') as any;
        expect(survivor.is_manual).toBe(1);
        expect(survivor.manual_description).toBe('Manuale B');
    });

    test('npc merge: 1 survivor, history ripuntata, RAG loser eliminato, ref migrati', async () => {
        updateNpcEntry(campaignId, 'Vescovo A', 'Bio A', 'Sacerdote', undefined, 'sess-a');
        updateNpcEntry(campaignId, 'Vescovo B', 'Bio B', 'Sacerdote', undefined, 'sess-b');
        addNpcEvent(campaignId, 'Vescovo B', 'sess-b', 'Ha tradito il party', 'BETRAYAL');

        insertKnowledgeFragment(campaignId, 'DOSSIER_UPDATE', '[[SCHEDA UFFICIALE: Vescovo B]]\nBio B', [0.1, 0.2, 0.3], EMBED_MODEL, 0, null, null, ['Vescovo B']);

        const report = await mergeNpcsByName(campaignId, 'Vescovo B', 'Vescovo A', { mergedDescription: 'Bio merged' });
        expect(report).not.toBeNull();

        expect(getNpcEntry(campaignId, 'Vescovo B')).toBeFalsy();
        const survivor = getNpcEntry(campaignId, 'Vescovo A')!;
        expect(survivor.description).toBe('Bio merged');

        // history ripuntata
        const hist = (npcHistory(campaignId, 'Vescovo A'));
        expect(hist.some((h: any) => h.description.includes('Ha tradito il party'))).toBe(true);

        // the loser's RAG card deleted
        const dossiers = getKnowledgeFragments(campaignId, EMBED_MODEL).filter((f: any) => f.session_id === 'DOSSIER_UPDATE');
        expect(dossiers.some((f: any) => f.content.includes('Vescovo B'))).toBe(false);
    });

    test('npc merge: does not delete the record of a name that contains the loser\'s', async () => {
        updateNpcEntry(campaignId, 'Ann', 'Bio Ann', 'Messaggera', undefined, 'sess-ann');
        updateNpcEntry(campaignId, 'Anna', 'Bio Anna', 'Studiosa', undefined, 'sess-anna');
        updateNpcEntry(campaignId, 'Anne Target', 'Bio target', 'Guida', undefined, 'sess-target');

        insertKnowledgeFragment(
            campaignId,
            'DOSSIER_UPDATE',
            '[[SCHEDA UFFICIALE: Ann]]\nBio Ann',
            [0.1],
            EMBED_MODEL,
            0,
            null,
            null,
            ['Ann'],
        );
        insertKnowledgeFragment(
            campaignId,
            'DOSSIER_UPDATE',
            '[[SCHEDA UFFICIALE: Anna]]\nBio Anna',
            [0.2],
            EMBED_MODEL,
            0,
            null,
            null,
            ['Anna'],
        );

        await mergeNpcsByName(campaignId, 'Ann', 'Anne Target');

        const dossiers = getKnowledgeFragments(campaignId, EMBED_MODEL)
            .filter((fragment: any) => fragment.session_id === 'DOSSIER_UPDATE');
        expect(dossiers.some((fragment: any) => fragment.content.includes('[[SCHEDA UFFICIALE: Ann]]'))).toBe(false);
        expect(dossiers.some((fragment: any) => fragment.content.includes('[[SCHEDA UFFICIALE: Anna]]'))).toBe(true);
    });

    test('faction merge: keeps history, members and RAG metadata, and deletes only the loser', () => {
        const suffix = `${process.pid}-${Date.now()}`;
        const sourceName = `Dame di Ferro ${suffix}`;
        const targetName = `Vergini di Ferro ${suffix}`;
        factionRepository.createFaction(campaignId, sourceName, { description: 'Bio Dame', type: 'ORGANIZATION' });
        factionRepository.createFaction(campaignId, targetName, { description: 'Bio Vergini', type: 'ORGANIZATION' });
        const source = factionRepository.getFaction(campaignId, sourceName)!;
        const target = factionRepository.getFaction(campaignId, targetName)!;

        updateNpcEntry(campaignId, `Dama A ${suffix}`, 'A', 'Guerriera');
        updateNpcEntry(campaignId, `Dama B ${suffix}`, 'B', 'Guerriera');
        const npcA = getNpcEntry(campaignId, `Dama A ${suffix}`)!;
        const npcB = getNpcEntry(campaignId, `Dama B ${suffix}`)!;
        factionRepository.addAffiliation(source.id, 'npc', npcA.id, { role: 'MEMBER', notes: 'fonte' });
        factionRepository.addAffiliation(target.id, 'npc', npcB.id, { role: 'LEADER', notes: 'target' });
        factionRepository.addFactionEvent(
            campaignId,
            sourceName,
            'sess-faction',
            'Ha protetto il palazzo',
            'ALLIANCE',
        );

        insertKnowledgeFragment(
            campaignId,
            'FACTION_UPDATE',
            `[[SCHEDA FAZIONE UFFICIALE: ${sourceName}]]\nBio Dame`,
            [0.1],
            EMBED_MODEL,
            0,
            null,
            null,
            [sourceName],
        );
        insertKnowledgeFragment(
            campaignId,
            'FACTION_UPDATE',
            `[[SCHEDA FAZIONE UFFICIALE: ${targetName}]]\nBio Vergini`,
            [0.2],
            EMBED_MODEL,
            0,
            null,
            null,
            [targetName],
        );
        insertKnowledgeFragment(
            campaignId,
            'session-faction-ref',
            `Le ${sourceName} sorvegliano la città`,
            [0.3],
            EMBED_MODEL,
            0,
            null,
            null,
            [sourceName],
            [`faction:${source.id}`],
        );

        const report = factionRepository.mergeFactionsById(
            campaignId,
            source.id,
            target.id,
            'Bio unificata',
        );
        expect(report).not.toBeNull();
        expect(report?.historyRepointed).toBe(1);
        expect(report?.affiliationsRepointed).toBe(1);
        expect(report?.ragFragmentsDeleted).toBe(1);

        expect(factionRepository.getFaction(campaignId, sourceName)).toBeNull();
        expect(factionRepository.getFaction(campaignId, targetName)?.description).toBe('Bio unificata');
        expect(factionRepository.countFactionMembers(target.id).npcs).toBe(2);
        expect(
            factionRepository.getFactionHistory(campaignId, targetName)
                .some((event) => event.description === 'Ha protetto il palazzo'),
        ).toBe(true);

        const fragments = getKnowledgeFragments(campaignId, EMBED_MODEL);
        expect(fragments.some((fragment) =>
            fragment.content.includes(`[[SCHEDA FAZIONE UFFICIALE: ${sourceName}]]`),
        )).toBe(false);
        expect(fragments.some((fragment) =>
            fragment.content.includes(`[[SCHEDA FAZIONE UFFICIALE: ${targetName}]]`),
        )).toBe(true);
        const ref = fragments.find((fragment) => fragment.session_id === 'session-faction-ref')!;
        expect(JSON.parse(ref.associated_npcs ?? '[]')).toContain(targetName);
        expect(ref.associated_entity_ids?.split(',')).toContain(`faction:${target.id}`);
        expect(ref.associated_entity_ids?.split(',')).not.toContain(`faction:${source.id}`);
    });
});

/** helper: reads npc_history directly (npcRepository.getNpcHistory is available but
 *  we keep the query local so as not to depend on the exact export). */
function npcHistory(campaignId: number, name: string): any[] {
    return db.prepare('SELECT * FROM npc_history WHERE campaign_id = ? AND lower(npc_name) = lower(?)').all(campaignId, name) as any[];
}
