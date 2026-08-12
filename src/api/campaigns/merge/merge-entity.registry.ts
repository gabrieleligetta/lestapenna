import {
    artifactRepository,
    factionRepository,
    getAllNpcs,
    getNpcByShortId,
    npcRepository,
} from '../../../db';
import { db } from '../../../db/client';
import type { EntityType } from '../../../bard/reconciliation/entityIndex';
import {
    mergeArtifactsByName,
    mergeNpcsByNamePrepared,
    renameArtifactAfterMerge,
    renameFactionAfterMerge,
    renameNpcAfterMerge,
    type RenameReport,
} from '../../../bard/reconciliation/merge';
import { smartMergeBios } from '../../../bard/reconciliation/npc';
import type { MergeableEntityType } from '../dto/merge.dto';

export interface MergeEntity {
    id: number;
    short_id?: string;
    name: string;
    description?: string | null;
    is_manual?: number;
    manual_description?: string | null;
    [key: string]: unknown;
}

export interface MergeHistoryItem {
    event_type?: string;
    description?: string;
    timestamp?: number;
}

export type MergeFieldPolicy = 'survivor' | 'fill-empty';

export interface MergeFieldSpec {
    key: string;
    /**
     * `survivor`: the survivor's value always wins.
     * `fill-empty`: the first non-empty value from the losers fills an empty survivor.
     */
    policy: MergeFieldPolicy;
}

export interface RagReferenceRow {
    id: number;
    header: string;
}

export interface PreparedMerge {
    description?: string;
    bioAutoMerged: boolean;
}

export interface AppliedDropReport {
    shortIdRegenerated: boolean;
    manualPropagated: boolean;
    relationsRepointed: number;
}

export interface MergeRelation {
    relationType: string;
    label: string;
    action: 'repointed' | 'deduplicated';
}

/**
 * Complete adapter for an entity family. The service and the UI always work
 * with the same N→1 flow; the only storage differences live here.
 */
export interface MergeEntitySpec {
    reconciliationType: EntityType;
    fragmentType: 'ARTIFACT_UPDATE' | 'DOSSIER_UPDATE' | 'FACTION_UPDATE';
    fields: readonly MergeFieldSpec[];
    list(campaignId: number): MergeEntity[];
    getByShortId(campaignId: number, shortId: string): MergeEntity | null;
    getByName(campaignId: number, name: string): MergeEntity | null;
    history(campaignId: number, name: string): MergeHistoryItem[];
    officialHeader(name: string): string;
    referenceRows(campaignId: number, entity: MergeEntity, deletedIds: Set<number>): RagReferenceRow[];
    relations?(campaignId: number, entity: MergeEntity, survivor: MergeEntity): MergeRelation[];
    prepare(
        survivor: MergeEntity,
        drops: MergeEntity[],
        opts: { description?: string; autoMergeDescription?: boolean },
    ): Promise<PreparedMerge>;
    validateSelection?(survivor: MergeEntity, drops: MergeEntity[]): string | null;
    applyDrop(
        campaignId: number,
        drop: MergeEntity,
        survivorName: string,
        prepared: PreparedMerge,
    ): AppliedDropReport;
    rename(campaignId: number, survivorId: number, oldName: string, newName: string): RenameReport;
}

const artifactFields: readonly MergeFieldSpec[] = [
    { key: 'description', policy: 'fill-empty' },
    { key: 'effects', policy: 'fill-empty' },
    { key: 'owner_name', policy: 'survivor' },
    { key: 'status', policy: 'survivor' },
    { key: 'curse_description', policy: 'survivor' },
    { key: 'location_macro', policy: 'survivor' },
    { key: 'location_micro', policy: 'survivor' },
];

const npcFields: readonly MergeFieldSpec[] = [
    { key: 'description', policy: 'survivor' },
    { key: 'role', policy: 'survivor' },
    { key: 'status', policy: 'survivor' },
];

const factionFields: readonly MergeFieldSpec[] = [
    { key: 'description', policy: 'fill-empty' },
    { key: 'type', policy: 'survivor' },
    { key: 'status', policy: 'survivor' },
];

function contentPreview(content: string | null): string {
    return (content ?? '').split('\n', 1)[0].slice(0, 100);
}

function npcReferenceRows(campaignId: number, entity: MergeEntity, deletedIds: Set<number>): RagReferenceRow[] {
    const rows = db.prepare(
        `SELECT id, content, associated_npcs, associated_npc_ids, associated_entity_ids
         FROM knowledge_fragments
         WHERE campaign_id = ?`,
    ).all(campaignId) as Array<{
        id: number;
        content: string;
        associated_npcs: string | null;
        associated_npc_ids: string | null;
        associated_entity_ids: string | null;
    }>;

    const oldEntityRef = `npc:${entity.id}`;
    const oldLegacyId = String(entity.id);
    return rows.flatMap((row) => {
        if (deletedIds.has(row.id)) return [];

        let hasNameReference = false;
        try {
            const names = JSON.parse(row.associated_npcs ?? '[]');
            hasNameReference = Array.isArray(names) && names.includes(entity.name);
        } catch {
            // Legacy non-JSON data: the other references may still be valid.
        }
        const entityRefs = (row.associated_entity_ids ?? '').split(',').map((value) => value.trim());
        const legacyIds = (row.associated_npc_ids ?? '').split(',').map((value) => value.trim());
        if (!hasNameReference && !entityRefs.includes(oldEntityRef) && !legacyIds.includes(oldLegacyId)) return [];
        return [{ id: row.id, header: contentPreview(row.content) }];
    });
}

function factionReferenceRows(campaignId: number, entity: MergeEntity, deletedIds: Set<number>): RagReferenceRow[] {
    const rows = db.prepare(`
        SELECT id, content, associated_npcs, associated_entity_ids
        FROM knowledge_fragments
        WHERE campaign_id = ?
    `).all(campaignId) as Array<{
        id: number;
        content: string;
        associated_npcs: string | null;
        associated_entity_ids: string | null;
    }>;
    const oldEntityRef = `faction:${entity.id}`;

    return rows.flatMap((row) => {
        if (deletedIds.has(row.id)) return [];
        let hasNameReference = false;
        try {
            const names = JSON.parse(row.associated_npcs ?? '[]');
            hasNameReference = Array.isArray(names) && names.includes(entity.name);
        } catch {
            // I ref tipizzati restano comunque verificabili.
        }
        const entityRefs = (row.associated_entity_ids ?? '')
            .split(',')
            .map((value) => value.trim());
        if (!hasNameReference && !entityRefs.includes(oldEntityRef)) return [];
        return [{ id: row.id, header: contentPreview(row.content) }];
    });
}

export const MERGE_ENTITY_SPECS: Record<MergeableEntityType, MergeEntitySpec> = {
    artifacts: {
        reconciliationType: 'artifact',
        fragmentType: 'ARTIFACT_UPDATE',
        fields: artifactFields,
        list: (campaignId) => artifactRepository.listAllArtifacts(campaignId) as unknown as MergeEntity[],
        getByShortId: (campaignId, shortId) =>
            (artifactRepository.getArtifactByShortId(campaignId, shortId) as MergeEntity | null) ?? null,
        getByName: (campaignId, name) =>
            (artifactRepository.getArtifactByName(campaignId, name) as MergeEntity | null) ?? null,
        history: (campaignId, name) => artifactRepository.getArtifactHistory(campaignId, name),
        officialHeader: (name) => `[[SCHEDA ARTEFATTO UFFICIALE: ${name}]]`,
        referenceRows: (campaignId, entity) => {
            const header = `[[SCHEDA ARTEFATTO UFFICIALE: ${entity.name}]]`;
            const rows = db.prepare(
                `SELECT id, content FROM knowledge_fragments
                 WHERE campaign_id = ? AND session_id = 'INVENTORY_UPDATE' AND INSTR(content, ?) > 0`,
            ).all(campaignId, header) as Array<{ id: number; content: string }>;
            return rows.map((row) => ({ id: row.id, header: contentPreview(row.content) }));
        },
        prepare: async (_survivor, _drops, opts) => ({
            description: opts.description?.trim() || undefined,
            bioAutoMerged: false,
        }),
        applyDrop: (campaignId, drop, survivorName, prepared) => {
            const target = artifactRepository.getArtifactByName(campaignId, survivorName) as MergeEntity | null;
            if (!target || !mergeArtifactsByName(campaignId, drop.name, survivorName, prepared.description)) {
                throw new Error(`Artifact "${drop.name}" could not be merged`);
            }
            return {
                shortIdRegenerated: Boolean(target.short_id && target.short_id === drop.short_id),
                manualPropagated: target.is_manual !== 1 && drop.is_manual === 1,
                relationsRepointed: 0,
            };
        },
        rename: renameArtifactAfterMerge,
    },
    npcs: {
        reconciliationType: 'npc',
        fragmentType: 'DOSSIER_UPDATE',
        fields: npcFields,
        list: (campaignId) => getAllNpcs(campaignId) as unknown as MergeEntity[],
        getByShortId: (campaignId, shortId) =>
            (getNpcByShortId(campaignId, shortId) as MergeEntity | null) ?? null,
        getByName: (campaignId, name) =>
            (npcRepository.getNpcEntry(campaignId, name) as MergeEntity | undefined) ?? null,
        history: (campaignId, name) => npcRepository.getNpcHistory(campaignId, name),
        officialHeader: (name) => `[[SCHEDA UFFICIALE: ${name}]]`,
        referenceRows: npcReferenceRows,
        prepare: async (survivor, drops, opts) => {
            const override = opts.description?.trim();
            if (override) return { description: override, bioAutoMerged: false };
            if (!opts.autoMergeDescription) return { bioAutoMerged: false };

            let description = String(survivor.description ?? '');
            let bioAutoMerged = false;
            for (const drop of drops) {
                const sourceDescription = String(drop.description ?? '');
                if (!sourceDescription) continue;
                const merged = await smartMergeBios(survivor.name, description, sourceDescription);
                bioAutoMerged = bioAutoMerged || merged !== description;
                description = merged;
            }
            return { description: description || undefined, bioAutoMerged };
        },
        applyDrop: (campaignId, drop, survivorName, prepared) => {
            const report = mergeNpcsByNamePrepared(campaignId, drop.name, survivorName, {
                mergedDescription: prepared.description,
                bioAutoMerged: prepared.bioAutoMerged,
            });
            if (!report) throw new Error(`NPC "${drop.name}" could not be merged`);
            return {
                shortIdRegenerated: report.shortIdRegenerated,
                manualPropagated: report.manualPropagated,
                relationsRepointed: 0,
            };
        },
        rename: renameNpcAfterMerge,
    },
    factions: {
        reconciliationType: 'faction',
        fragmentType: 'FACTION_UPDATE',
        fields: factionFields,
        // The Party faction is structural and cannot be absorbed/deleted.
        list: (campaignId) =>
            factionRepository.listFactions(campaignId, false) as unknown as MergeEntity[],
        getByShortId: (campaignId, shortId) =>
            (factionRepository.getFactionByShortId(campaignId, shortId) as MergeEntity | null) ?? null,
        getByName: (campaignId, name) =>
            (factionRepository.getFaction(campaignId, name) as MergeEntity | null) ?? null,
        history: (campaignId, name) => factionRepository.getFactionHistory(campaignId, name),
        officialHeader: (name) => `[[SCHEDA FAZIONE UFFICIALE: ${name}]]`,
        referenceRows: factionReferenceRows,
        relations: (campaignId, entity, survivor) => {
            const targetRelations = new Set(
                (db.prepare(`
                    SELECT entity_type, entity_id
                    FROM faction_affiliations
                    WHERE faction_id = ?
                `).all(survivor.id) as Array<{ entity_type: string; entity_id: number }>)
                    .map((row) => `${row.entity_type}:${row.entity_id}`),
            );
            const memberships = factionRepository
                .listFactionMembersDetailed(entity.id, false)
                .map((row) => ({
                    relationType: 'membership',
                    label: `${row.name ?? `${row.entity_type}:${row.entity_id}`} · ${row.role}`,
                    action: targetRelations.has(`${row.entity_type}:${row.entity_id}`)
                        ? 'deduplicated' as const
                        : 'repointed' as const,
                }));
            const artifacts = db.prepare(`
                SELECT name FROM artifacts
                WHERE campaign_id = ? AND faction_id = ?
                ORDER BY name
            `).all(campaignId, entity.id) as Array<{ name: string }>;
            return [
                ...memberships,
                ...artifacts.map((artifact) => ({
                    relationType: 'artifact',
                    label: artifact.name,
                    action: 'repointed' as const,
                })),
            ];
        },
        prepare: async (survivor, drops, opts) => {
            const override = opts.description?.trim();
            if (override) return { description: override, bioAutoMerged: false };
            const inherited = String(survivor.description ?? '').trim()
                || drops.map((drop) => String(drop.description ?? '').trim()).find(Boolean);
            return { description: inherited || undefined, bioAutoMerged: false };
        },
        validateSelection: (survivor, drops) =>
            [survivor, ...drops].some((entity) => entity.is_party === 1)
                ? 'The Party faction cannot be merged'
                : null,
        applyDrop: (campaignId, drop, survivorName, prepared) => {
            const target = factionRepository.getFaction(campaignId, survivorName);
            if (!target) throw new Error(`Faction survivor "${survivorName}" not found`);
            const report = factionRepository.mergeFactionsById(
                campaignId,
                drop.id,
                target.id,
                prepared.description,
            );
            if (!report) throw new Error(`Faction "${drop.name}" could not be merged`);
            return {
                shortIdRegenerated: report.shortIdRegenerated,
                manualPropagated: report.manualPropagated,
                relationsRepointed: report.affiliationsRepointed + report.artifactsRepointed,
            };
        },
        rename: renameFactionAfterMerge,
    },
};
