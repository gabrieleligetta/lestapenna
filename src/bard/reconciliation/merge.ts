/**
 * Entity merge — survivor/loser merge for entities with full merge logic.
 *
 * Extracted from the `$npc merge` Discord command (commands/npcs/npc.ts) and from
 * `artifactRepository.mergeArtifacts` so it can be reused by the HTTP path (web app)
 * as well as by Discord. Both merges act on:
 *   1. the DB record (repoint history, delete loser, propagate is_manual/short_id)
 *   2. the RAG/historical memory (unified card timeline, migrate refs, invalidate vector cache)
 *
 * The artifact merge lives in the repository (artifactRepository.mergeArtifacts) because
 * that is where it already existed; here we only expose a thin wrapper for symmetry. The NPC
 * merge is orchestrated here because it has to coordinate the NPC repository + the knowledge
 * repository + smartMergeBios (LLM, optional) + invalidateEntityVectors.
 */

import { db } from '../../db/client';
import {
    updateNpcEntry,
    getNpcEntry,
    getNpcIdByName,
    migrateKnowledgeFragments,
    migrateRagNpcReferences,
    deleteNpcHistory,
    deleteNpcEntry,
    artifactRepository,
    getArtifactByName,
    knowledgeRepository,
} from '../../db';
import { generateShortId } from '../../db/utils/idGenerator';
import { smartMergeBios } from './npc';
import { invalidateEntityVectors } from './semantic';

export interface MergeNpcOptions {
    /** A merged description that is already prepared (e.g. from fieldOverrides). When absent and
     *  autoMergeBio=true, it calls smartMergeBios (LLM). Otherwise the survivor's bio wins. */
    mergedDescription?: string;
    /** When true and no mergedDescription is supplied, it merges the bios via LLM (smartMergeBios). */
    autoMergeBio?: boolean;
}

export interface NpcMergeReport {
    historyRepointed: number;
    ragFragmentsMigrated: number;
    ragRefsMigrated: number;
    shortIdRegenerated: boolean;
    manualPropagated: boolean;
    bioAutoMerged: boolean;
}

export interface PreparedNpcMergeOptions {
    mergedDescription?: string;
    bioAutoMerged?: boolean;
}

/**
 * Merges a "source" NPC (loser) into a "target" (survivor) by name.
 * Atomic DB transaction plus RAG cleanup; invalidateEntityVectors fuori tx.
 * Ritorna null se source o target non esistono.
 */
export async function mergeNpcsByName(
    campaignId: number,
    oldName: string,
    newName: string,
    opts: MergeNpcOptions = {}
): Promise<NpcMergeReport | null> {
    const source = getNpcEntry(campaignId, oldName);
    const target = getNpcEntry(campaignId, newName);
    if (!source || !target) return null;

    // Risolvi la descrizione merged.
    let mergedDescription = opts.mergedDescription;
    let bioAutoMerged = false;
    if (!mergedDescription && opts.autoMergeBio) {
        const sourceBio = source.description || '';
        const targetBio = target.description || '';
        if (sourceBio && targetBio) {
            mergedDescription = await smartMergeBios(newName, targetBio, sourceBio);
            bioAutoMerged = !!mergedDescription;
        }
    }

    return mergeNpcsByNamePrepared(campaignId, oldName, newName, {
        mergedDescription,
        bioAutoMerged,
    });
}

/**
 * Applies an already planned NPC merge. It is synchronous so it can be composed
 * into the N→1 transaction of the web flow; any AI calls happen beforehand,
 * in `mergeNpcsByName` or in the capability's registry.
 */
export function mergeNpcsByNamePrepared(
    campaignId: number,
    oldName: string,
    newName: string,
    opts: PreparedNpcMergeOptions = {},
): NpcMergeReport | null {
    const source = getNpcEntry(campaignId, oldName);
    const target = getNpcEntry(campaignId, newName);
    if (!source || !target) return null;

    const sourceId = getNpcIdByName(campaignId, oldName);
    const targetId = getNpcIdByName(campaignId, newName);
    if (sourceId == null || targetId == null) return null;

    const propagateManual = (target as any).is_manual !== 1 && (source as any).is_manual === 1;
    const shortIdCollision = (target as any).short_id && (target as any).short_id === (source as any).short_id;

    const report: NpcMergeReport = {
        historyRepointed: 0,
        ragFragmentsMigrated: 0,
        ragRefsMigrated: 0,
        shortIdRegenerated: false,
        manualPropagated: propagateManual,
        bioAutoMerged: opts.bioAutoMerged ?? false,
    };

    db.transaction(() => {
        // 1. Move history (per nome, case-insensitive)
        const histRes = db.prepare(
            `UPDATE npc_history SET npc_name = ? WHERE campaign_id = ? AND lower(npc_name) = lower(?)`
        ).run(newName, campaignId, oldName);
        report.historyRepointed = histRes.changes;

        // 2. Bio merged (se fornita/auto-mergiata)
        if (opts.mergedDescription) {
            updateNpcEntry(campaignId, newName, opts.mergedDescription, undefined, undefined, undefined, true);
        }

        // 3. Propagate manual + regenerate the survivor's short_id
        if (propagateManual) {
            db.prepare(
                `UPDATE npc_dossier SET is_manual = 1, manual_description = COALESCE(?, manual_description) WHERE id = ?`
            ).run((source as any).manual_description ?? null, targetId);
        }
        if (shortIdCollision) {
            db.prepare(`UPDATE npc_dossier SET short_id = ? WHERE id = ?`)
                .run(generateShortId('npc_dossier'), targetId);
            report.shortIdRegenerated = true;
        }

        // 4. Move faction_affiliations (conflict-delete: if the target already has an affiliation
        //    with the same faction, drop the source's instead of violating the unique).
        const sourceAffiliations = db.prepare(
            `SELECT id, faction_id FROM faction_affiliations WHERE entity_type = 'npc' AND entity_id = ?`
        ).all(sourceId) as { id: number; faction_id: number }[];
        for (const aff of sourceAffiliations) {
            const conflict = db.prepare(
                `SELECT id FROM faction_affiliations WHERE faction_id = ? AND entity_type = 'npc' AND entity_id = ?`
            ).get(aff.faction_id, targetId) as { id: number } | undefined;
            if (conflict) {
                db.prepare(`DELETE FROM faction_affiliations WHERE id = ?`).run(aff.id);
            } else {
                db.prepare(`UPDATE faction_affiliations SET entity_id = ? WHERE id = ?`).run(targetId, aff.id);
            }
        }

        // 5. Unify the DOSSIER_UPDATE cards: a single canonical fragment, with
        //    the current state and the full history of both identities.
        knowledgeRepository.mergeEntityRagSnapshots(
            campaignId,
            'DOSSIER_UPDATE',
            `[[SCHEDA UFFICIALE: ${oldName}]]`,
            `[[SCHEDA UFFICIALE: ${newName}]]`,
        );

        // 6. Migrate RAG (associated_npcs name arrays) on the remaining fragments that
        //    mention oldName (e.g. session chunks) → newName.
        migrateKnowledgeFragments(campaignId, oldName, newName);

        // 7. Migrate RAG entity refs (npc:OLD → npc:NEW) — a gap in the original command,
        //    which did not call migrateRagNpcReferences and left associated_entity_ids stale.
        report.ragRefsMigrated = migrateRagNpcReferences(campaignId, sourceId, targetId);

        // 8. Delete source (history + entry)
        deleteNpcHistory(campaignId, oldName);
        deleteNpcEntry(campaignId, oldName);
    })();

    // Outside the transaction: invalidates the entity vector cache (bard layer).
    try {
        invalidateEntityVectors(campaignId);
    } catch (e) {
        console.warn('[Merge] ⚠️ invalidateEntityVectors skip:', (e as Error).message);
    }

    console.log(`[Merge] 👤 NPC merged: ${oldName} -> ${newName} (hist=${report.historyRepointed}, refs=${report.ragRefsMigrated})`);
    return report;
}

/**
 * Thin symmetry wrapper for artifacts. The full logic (DB + RAG + short_id)
 * lives in artifactRepository.mergeArtifacts; here we only resolve the names and return
 * a report consistent with the NPC one.
 */
export function mergeArtifactsByName(
    campaignId: number,
    oldName: string,
    newName: string,
    mergedDescription?: string
): boolean {
    // Verifica esistenza source per ritornare false coerentemente.
    if (!getArtifactByName(campaignId, oldName)) return false;
    return artifactRepository.mergeArtifacts(campaignId, oldName, newName, mergedDescription);
}

// --- Renaming the survivor after a merge (final_name chosen by the user) ---

export interface RenameReport {
    historyRepointed: number;
    ragHeadersRewritten: number;
    ragRefsRewritten: number;
}

/** Renames the surviving artifact to the final name chosen by the user (when
 *  `final_name` ≠ the survivor's current name). Updates the record, repoints the history,
 *  rewrites the header of the ARTIFACT_UPDATE RAG card + the INVENTORY_UPDATE refs to the
 *  new name, invalidates the vector cache. No LLM call. */
export function renameArtifactAfterMerge(
    campaignId: number,
    survivorId: number,
    oldName: string,
    newName: string,
): RenameReport {
    const report: RenameReport = { historyRepointed: 0, ragHeadersRewritten: 0, ragRefsRewritten: 0 };
    if (!oldName || !newName || oldName === newName) return report;
    const oldHeader = `[[SCHEDA ARTEFATTO UFFICIALE: ${oldName}]]`;
    const newHeader = `[[SCHEDA ARTEFATTO UFFICIALE: ${newName}]]`;
    db.transaction(() => {
        db.prepare(`UPDATE artifacts SET name = ?, rag_sync_needed = 1 WHERE id = ?`).run(newName, survivorId);
        const h = db.prepare(
            `UPDATE artifact_history SET artifact_name = ?
             WHERE campaign_id = ?
               AND (entity_id = ? OR (entity_id IS NULL AND lower(artifact_name) = lower(?)))`,
        ).run(newName, campaignId, survivorId, oldName);
        report.historyRepointed = h.changes;
        report.ragHeadersRewritten = knowledgeRepository.rewriteEntityRagHeader(campaignId, 'ARTIFACT_UPDATE', oldHeader, newHeader);
        report.ragRefsRewritten = knowledgeRepository.rewriteArtifactRagNameRefs(campaignId, oldName, newName);
    })();
    try { invalidateEntityVectors(campaignId); } catch (e) { console.warn('[Merge] ⚠️ invalidateEntityVectors skip:', (e as Error).message); }
    console.log(`[Merge] ✏️ Artifact survivor renamed: "${oldName}" → "${newName}" (hist=${report.historyRepointed}, refs=${report.ragRefsRewritten})`);
    return report;
}

/** Renames the surviving NPC to the final name. Rewrites the DOSSIER_UPDATE
 header */
export function renameNpcAfterMerge(
    campaignId: number,
    survivorId: number,
    oldName: string,
    newName: string,
): RenameReport {
    const report: RenameReport = { historyRepointed: 0, ragHeadersRewritten: 0, ragRefsRewritten: 0 };
    if (!oldName || !newName || oldName === newName) return report;
    const oldHeader = `[[SCHEDA UFFICIALE: ${oldName}]]`;
    const newHeader = `[[SCHEDA UFFICIALE: ${newName}]]`;
    db.transaction(() => {
        db.prepare(`UPDATE npc_dossier SET name = ?, rag_sync_needed = 1 WHERE id = ?`).run(newName, survivorId);
        const h = db.prepare(
            `UPDATE npc_history SET npc_name = ?
             WHERE campaign_id = ?
               AND (entity_id = ? OR (entity_id IS NULL AND lower(npc_name) = lower(?)))`,
        ).run(newName, campaignId, survivorId, oldName);
        report.historyRepointed = h.changes;
        report.ragHeadersRewritten = knowledgeRepository.rewriteEntityRagHeader(campaignId, 'DOSSIER_UPDATE', oldHeader, newHeader);
        report.ragRefsRewritten = knowledgeRepository.rewriteNpcRagAssociatedRefs(campaignId, oldName, newName);
    })();
    try { invalidateEntityVectors(campaignId); } catch (e) { console.warn('[Merge] ⚠️ invalidateEntityVectors skip:', (e as Error).message); }
    console.log(`[Merge] ✏️ NPC survivor renamed: "${oldName}" → "${newName}" (hist=${report.historyRepointed}, refs=${report.ragRefsRewritten})`);
    return report;
}

/** Renames the surviving faction and keeps the history, the official FACTION_UPDATE
 * card and the by-name references stored in the RAG fragments consistent. */
export function renameFactionAfterMerge(
    campaignId: number,
    survivorId: number,
    oldName: string,
    newName: string,
): RenameReport {
    const report: RenameReport = { historyRepointed: 0, ragHeadersRewritten: 0, ragRefsRewritten: 0 };
    if (!oldName || !newName || oldName === newName) return report;
    const oldHeader = `[[SCHEDA FAZIONE UFFICIALE: ${oldName}]]`;
    const newHeader = `[[SCHEDA FAZIONE UFFICIALE: ${newName}]]`;

    db.transaction(() => {
        const renamed = db.prepare(`
            UPDATE factions
            SET name = ?, rag_sync_needed = 1, last_updated = CURRENT_TIMESTAMP
            WHERE id = ? AND campaign_id = ?
        `).run(newName, survivorId, campaignId);
        if (renamed.changes !== 1) throw new Error('Faction survivor could not be renamed');

        const history = db.prepare(`
            UPDATE faction_history
            SET faction_name = ?
            WHERE campaign_id = ?
              AND (entity_id = ? OR (entity_id IS NULL AND lower(faction_name) = lower(?)))
        `).run(newName, campaignId, survivorId, oldName);
        report.historyRepointed = history.changes;
        report.ragHeadersRewritten = knowledgeRepository.rewriteEntityRagHeader(
            campaignId,
            'FACTION_UPDATE',
            oldHeader,
            newHeader,
        );
        report.ragRefsRewritten = knowledgeRepository.rewriteFactionRagAssociatedRefs(
            campaignId,
            oldName,
            newName,
        );
    })();

    try {
        invalidateEntityVectors(campaignId);
    } catch (error) {
        console.warn('[Merge] ⚠️ invalidateEntityVectors skip:', (error as Error).message);
    }
    console.log(`[Merge] ✏️ Faction survivor renamed: "${oldName}" → "${newName}" (hist=${report.historyRepointed}, refs=${report.ragRefsRewritten})`);
    return report;
}
