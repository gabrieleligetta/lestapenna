import { BadRequestException } from '@nestjs/common';
import { db } from '../../../db/client';
import {
    artifactRepository,
    bestiaryRepository,
    factionRepository,
    inventoryRepository,
    locationRepository,
    npcRepository,
    questRepository,
    worldRepository,
} from '../../../db';
import {
    ENTITY_DELETE_SPECS,
    asRow,
    type CrudEntityType,
    type CrudRow,
    type EntityDeleteSpec,
} from '../../../services/entityDeletion';
import {
    ARTIFACT_STATUSES,
    BESTIARY_STATUSES,
    FACTION_STATUSES,
    FACTION_TYPES,
    INVENTORY_CATEGORIES,
    NPC_STATUSES,
    QUEST_STATUSES,
    QUEST_TYPES,
    TIMELINE_EVENT_TYPES,
} from './entity-crud.enums';
import {
    CrudFieldSpec,
    CrudInput,
    pickRequired,
    pickString,
} from './entity-crud.fields';

/**
 * The entity vocabulary and everything to do with their deletion lives in
 * `services/entityDeletion.ts`: the cascade has two callers — this CRUD and the
 * Discord commands — and could not stay under `src/api/`. It is re-exported
 * here so the API consumers do not depend on the domain path.
 */
export {
    CRUD_ENTITY_TYPES,
    isCrudEntityType,
    type CrudEntityType,
    type CrudRow,
    type HistorySpec,
} from '../../../services/entityDeletion';

/**
 * The delete spec (history, RAG, relations, readable name) plus what is needed
 * only for writing from the web: field schema, lookups and mutations. Every spec
 * below starts from `...ENTITY_DELETE_SPECS.<family>`, so the two halves cannot
 * diverge.
 */
export interface EntityCrudSpec extends EntityDeleteSpec {
    /** Editable fields, in the order the editor shows them. */
    fields: readonly CrudFieldSpec[];
    find(campaignId: number, shortId: string): CrudRow | null;
    /** The entity with the same natural key, to catch conflicts. */
    findByInput(campaignId: number, input: CrudInput): CrudRow | null;
    create(campaignId: number, input: CrudInput): CrudRow;
    update(campaignId: number, current: CrudRow, input: CrudInput): CrudRow;
}

/** Re-reads the row just written; its absence here is always a bug, not a 404. */
function reread(value: unknown, what: string): CrudRow {
    const row = asRow(value);
    if (!row) throw new BadRequestException(`${what} could not be read back after the write`);
    return row;
}

const npcSpec: EntityCrudSpec = {
    ...ENTITY_DELETE_SPECS.npcs,
    fields: [
        { key: 'name', type: 'text', required: true, maxLength: 160 },
        { key: 'description', type: 'longtext' },
        { key: 'role', type: 'text', maxLength: 120 },
        { key: 'status', type: 'enum', values: NPC_STATUSES },
        { key: 'aliases', type: 'stringList', maxLength: 120, maxItems: 25 },
    ],
    find: (campaignId, shortId) => asRow(npcRepository.getNpcByShortId(campaignId, shortId)),
    findByInput: (campaignId, input) => {
        const name = pickString(input, 'name');
        return name ? asRow(npcRepository.getNpcEntry(campaignId, name)) : null;
    },
    create: (campaignId, input) => {
        const name = pickRequired(input, 'name', '');
        npcRepository.updateNpcEntry(
            campaignId,
            name,
            pickString(input, 'description') ?? '',
            pickString(input, 'role') ?? undefined,
            pickString(input, 'status') ?? 'ALIVE',
            undefined,
            true,
        );
        const aliases = input.aliases as string[] | undefined;
        if (aliases?.length) npcRepository.updateNpcAliases(campaignId, name, aliases);
        return reread(npcRepository.getNpcEntry(campaignId, name), 'NPC');
    },
    update: (campaignId, current, input) => {
        const currentName = String(current.name);
        const nextName = pickString(input, 'name', currentName) ?? currentName;

        const fields: Record<string, unknown> = {};
        if (input.description !== undefined) fields.description = pickString(input, 'description') ?? '';
        if (input.role !== undefined) fields.role = pickString(input, 'role');
        if (input.status !== undefined) fields.status = pickString(input, 'status');
        if (Object.keys(fields).length > 0) {
            npcRepository.updateNpcFields(campaignId, currentName, fields, true);
        }
        if (input.aliases !== undefined) {
            npcRepository.updateNpcAliases(campaignId, currentName, (input.aliases as string[]) ?? []);
        }
        // The rename repoints history and RAG references: it has to come last,
        // so the updates by name above still hit the right row.
        if (nextName.toLowerCase() !== currentName.toLowerCase()) {
            npcRepository.renameNpcEntry(campaignId, currentName, nextName);
        }
        return reread(npcRepository.getNpcEntry(campaignId, nextName), 'NPC');
    },
};

const locationSpec: EntityCrudSpec = {
    ...ENTITY_DELETE_SPECS.locations,
    fields: [
        { key: 'macro_location', type: 'text', required: true, maxLength: 160 },
        { key: 'micro_location', type: 'text', required: true, maxLength: 160 },
        { key: 'description', type: 'longtext' },
    ],
    find: (campaignId, shortId) => asRow(locationRepository.getAtlasEntryByShortId(campaignId, shortId)),
    findByInput: (campaignId, input) => {
        const macro = pickString(input, 'macro_location');
        const micro = pickString(input, 'micro_location');
        if (!macro || !micro) return null;
        return asRow(locationRepository.getAtlasEntryFull(campaignId, macro, micro));
    },
    create: (campaignId, input) => {
        const macro = pickRequired(input, 'macro_location', '');
        const micro = pickRequired(input, 'micro_location', '');
        locationRepository.updateAtlasEntry(
            campaignId,
            macro,
            micro,
            pickString(input, 'description') ?? '',
            undefined,
            true,
        );
        return reread(locationRepository.getAtlasEntryFull(campaignId, macro, micro), 'Location');
    },
    update: (campaignId, current, input) => {
        const currentMacro = String(current.macro_location);
        const currentMicro = String(current.micro_location);
        const nextMacro = pickString(input, 'macro_location', currentMacro) ?? currentMacro;
        const nextMicro = pickString(input, 'micro_location', currentMicro) ?? currentMicro;

        if (input.description !== undefined) {
            locationRepository.updateAtlasEntry(
                campaignId,
                currentMacro,
                currentMicro,
                pickString(input, 'description') ?? '',
                undefined,
                true,
            );
        }
        const renamed =
            nextMacro.toLowerCase() !== currentMacro.toLowerCase()
            || nextMicro.toLowerCase() !== currentMicro.toLowerCase();
        if (renamed) {
            // `updateHistory: true` also moves the travel log, which is a
            // separate table from atlas_history (see the web app's data map).
            const renamedOk = locationRepository.renameAtlasEntry(
                campaignId, currentMacro, currentMicro, nextMacro, nextMicro, true,
            );
            if (!renamedOk) {
                throw new BadRequestException('Another atlas entry already uses that region and place');
            }
        }
        return reread(locationRepository.getAtlasEntryFull(campaignId, nextMacro, nextMicro), 'Location');
    },
};

const factionSpec: EntityCrudSpec = {
    ...ENTITY_DELETE_SPECS.factions,
    fields: [
        { key: 'name', type: 'text', required: true, maxLength: 160 },
        { key: 'description', type: 'longtext' },
        { key: 'type', type: 'enum', values: FACTION_TYPES },
        { key: 'status', type: 'enum', values: FACTION_STATUSES },
    ],
    find: (campaignId, shortId) => asRow(factionRepository.getFactionByShortId(campaignId, shortId)),
    findByInput: (campaignId, input) => {
        const name = pickString(input, 'name');
        return name ? asRow(factionRepository.getFaction(campaignId, name)) : null;
    },
    create: (campaignId, input) => {
        const name = pickRequired(input, 'name', '');
        factionRepository.createFaction(campaignId, name, {
            description: pickString(input, 'description') ?? undefined,
            type: (pickString(input, 'type') ?? 'GENERIC') as never,
            isManual: true,
        });
        const status = pickString(input, 'status');
        if (status) factionRepository.updateFaction(campaignId, name, { status } as never, true);
        return reread(factionRepository.getFaction(campaignId, name), 'Faction');
    },
    update: (campaignId, current, input) => {
        const currentName = String(current.name);
        const nextName = pickString(input, 'name', currentName) ?? currentName;

        const fields: Record<string, unknown> = {};
        if (input.description !== undefined) fields.description = pickString(input, 'description');
        if (input.type !== undefined) fields.type = pickString(input, 'type');
        if (input.status !== undefined) fields.status = pickString(input, 'status');
        if (Object.keys(fields).length > 0) {
            factionRepository.updateFaction(campaignId, currentName, fields as never, true);
        }
        if (nextName.toLowerCase() !== currentName.toLowerCase()) {
            const renamedOk = current.is_party === 1
                ? factionRepository.renamePartyFaction(campaignId, nextName)
                : factionRepository.renameFaction(campaignId, currentName, nextName);
            if (!renamedOk) throw new BadRequestException('Another faction already uses that name');
        }
        return reread(factionRepository.getFaction(campaignId, nextName), 'Faction');
    },
};

const questSpec: EntityCrudSpec = {
    ...ENTITY_DELETE_SPECS.quests,
    fields: [
        { key: 'title', type: 'text', required: true, maxLength: 160 },
        { key: 'description', type: 'longtext' },
        { key: 'status', type: 'enum', required: true, values: QUEST_STATUSES },
        { key: 'type', type: 'enum', required: true, values: QUEST_TYPES },
    ],
    find: (campaignId, shortId) => asRow(questRepository.getQuestByShortId(campaignId, shortId)),
    findByInput: (campaignId, input) => {
        const title = pickString(input, 'title');
        if (!title) return null;
        return asRow(db.prepare(
            'SELECT * FROM quests WHERE campaign_id = ? AND lower(title) = lower(?)',
        ).get(campaignId, title));
    },
    create: (campaignId, input) =>
        reread(questRepository.createManualQuest(campaignId, {
            title: pickRequired(input, 'title', ''),
            description: pickString(input, 'description'),
            status: pickRequired(input, 'status', 'OPEN') as never,
            type: pickRequired(input, 'type', 'MAJOR') as never,
        }), 'Quest'),
    update: (campaignId, current, input) =>
        reread(questRepository.updateQuestByShortId(campaignId, String(current.short_id), {
            title: pickRequired(input, 'title', String(current.title)),
            description: pickString(input, 'description', (current.description as string) ?? null),
            status: pickRequired(input, 'status', String(current.status)) as never,
            type: pickRequired(input, 'type', String(current.type)) as never,
        }), 'Quest'),
};

const inventorySpec: EntityCrudSpec = {
    ...ENTITY_DELETE_SPECS.inventory,
    fields: [
        { key: 'item_name', type: 'text', required: true, maxLength: 160 },
        { key: 'description', type: 'longtext' },
        { key: 'quantity', type: 'int', min: 0, max: 1_000_000 },
        { key: 'category', type: 'enum', values: INVENTORY_CATEGORIES },
        { key: 'notes', type: 'longtext', maxLength: 4000 },
    ],
    find: (campaignId, shortId) => asRow(inventoryRepository.getInventoryItemByShortId(campaignId, shortId)),
    findByInput: (campaignId, input) => {
        const name = pickString(input, 'item_name');
        return name ? asRow(inventoryRepository.getInventoryItemByName(campaignId, name)) : null;
    },
    create: (campaignId, input) => {
        const name = pickRequired(input, 'item_name', '');
        inventoryRepository.addLoot(
            campaignId,
            name,
            typeof input.quantity === 'number' ? input.quantity : 1,
            undefined,
            pickString(input, 'description') ?? undefined,
            true,
            undefined,
            (pickString(input, 'category') ?? undefined) as never,
        );
        const notes = pickString(input, 'notes');
        if (notes !== null) inventoryRepository.updateInventoryFields(campaignId, name, { notes }, true);
        return reread(inventoryRepository.getInventoryItemByName(campaignId, name), 'Item');
    },
    update: (campaignId, current, input) => {
        const currentName = String(current.item_name);
        const fields: Record<string, unknown> = {};
        if (input.item_name !== undefined) fields.item_name = pickString(input, 'item_name', currentName);
        if (input.description !== undefined) fields.description = pickString(input, 'description');
        if (input.notes !== undefined) fields.notes = pickString(input, 'notes');
        if (input.quantity !== undefined) fields.quantity = input.quantity;
        if (Object.keys(fields).length > 0) {
            inventoryRepository.updateInventoryFields(campaignId, currentName, fields as never, true);
        }
        const finalName = (fields.item_name as string) ?? currentName;
        if (input.category !== undefined) {
            inventoryRepository.updateInventoryCategory(campaignId, finalName, pickString(input, 'category') as never);
        }
        return reread(inventoryRepository.getInventoryItemByName(campaignId, finalName), 'Item');
    },
};

const artifactSpec: EntityCrudSpec = {
    ...ENTITY_DELETE_SPECS.artifacts,
    fields: [
        { key: 'name', type: 'text', required: true, maxLength: 160 },
        { key: 'description', type: 'longtext' },
        { key: 'effects', type: 'longtext', maxLength: 4000 },
        { key: 'status', type: 'enum', values: ARTIFACT_STATUSES },
        { key: 'is_cursed', type: 'bool' },
        { key: 'curse_description', type: 'longtext', maxLength: 4000 },
        { key: 'owner_name', type: 'text', maxLength: 160 },
        { key: 'location_macro', type: 'text', maxLength: 160 },
        { key: 'location_micro', type: 'text', maxLength: 160 },
    ],
    find: (campaignId, shortId) => asRow(artifactRepository.getArtifactByShortId(campaignId, shortId)),
    findByInput: (campaignId, input) => {
        const name = pickString(input, 'name');
        return name ? asRow(artifactRepository.getArtifactByName(campaignId, name)) : null;
    },
    create: (campaignId, input) => {
        const name = pickRequired(input, 'name', '');
        artifactRepository.upsertArtifact(
            campaignId,
            name,
            (pickString(input, 'status') ?? 'FUNCTIONAL') as never,
            undefined,
            {
                description: pickString(input, 'description') ?? undefined,
                effects: pickString(input, 'effects') ?? undefined,
                is_cursed: input.is_cursed === true,
                curse_description: pickString(input, 'curse_description') ?? undefined,
                owner_name: pickString(input, 'owner_name') ?? undefined,
                location_macro: pickString(input, 'location_macro') ?? undefined,
                location_micro: pickString(input, 'location_micro') ?? undefined,
            } as never,
            true,
        );
        return reread(artifactRepository.getArtifactByName(campaignId, name), 'Artifact');
    },
    update: (campaignId, current, input) => {
        const currentName = String(current.name);
        const fields: Record<string, unknown> = {};
        for (const key of [
            'name', 'description', 'effects', 'status',
            'curse_description', 'owner_name', 'location_macro', 'location_micro',
        ]) {
            if (input[key] !== undefined) fields[key] = pickString(input, key);
        }
        if (input.is_cursed !== undefined) fields.is_cursed = input.is_cursed === true;
        // The name is required: a patch that empties it does not delete it.
        if (fields.name === null) delete fields.name;

        // updateArtifactFields repoints artifact_history when the name changes.
        if (Object.keys(fields).length > 0) {
            artifactRepository.updateArtifactFields(campaignId, currentName, fields as never, true);
        }
        const finalName = (fields.name as string) ?? currentName;
        return reread(artifactRepository.getArtifactByName(campaignId, finalName), 'Artifact');
    },
};

const bestiarySpec: EntityCrudSpec = {
    ...ENTITY_DELETE_SPECS.bestiary,
    fields: [
        { key: 'name', type: 'text', required: true, maxLength: 160 },
        { key: 'description', type: 'longtext' },
        { key: 'status', type: 'enum', values: BESTIARY_STATUSES },
        { key: 'abilities', type: 'stringList', maxLength: 200, maxItems: 40 },
        { key: 'weaknesses', type: 'stringList', maxLength: 200, maxItems: 40 },
        { key: 'resistances', type: 'stringList', maxLength: 200, maxItems: 40 },
        { key: 'notes', type: 'longtext', maxLength: 4000 },
    ],
    find: (campaignId, shortId) => asRow(bestiaryRepository.getMonsterByShortId(campaignId, shortId)),
    findByInput: (campaignId, input) => {
        const name = pickString(input, 'name');
        return name ? asRow(bestiaryRepository.getMonsterByName(campaignId, name)) : null;
    },
    create: (campaignId, input) => {
        const name = pickRequired(input, 'name', '');
        bestiaryRepository.upsertMonster(
            campaignId,
            name,
            pickString(input, 'status') ?? 'ALIVE',
            undefined,
            {
                description: pickString(input, 'description') ?? undefined,
                abilities: (input.abilities as string[]) ?? undefined,
                weaknesses: (input.weaknesses as string[]) ?? undefined,
                resistances: (input.resistances as string[]) ?? undefined,
                notes: pickString(input, 'notes') ?? undefined,
            } as never,
            undefined,
            true,
        );
        return reread(bestiaryRepository.getMonsterByName(campaignId, name), 'Monster');
    },
    update: (campaignId, current, input) => {
        const currentName = String(current.name);
        const fields: Record<string, unknown> = {};
        if (input.name !== undefined && pickString(input, 'name')) fields.name = pickString(input, 'name');
        if (input.description !== undefined) fields.description = pickString(input, 'description');
        if (input.status !== undefined) fields.status = pickString(input, 'status');
        if (input.notes !== undefined) fields.notes = pickString(input, 'notes');
        for (const key of ['abilities', 'weaknesses', 'resistances']) {
            if (input[key] !== undefined) fields[key] = (input[key] as string[]) ?? [];
        }
        if (Object.keys(fields).length > 0) {
            bestiaryRepository.updateBestiaryFields(campaignId, currentName, fields as never, true);
        }
        const finalName = (fields.name as string) ?? currentName;
        return reread(bestiaryRepository.getMonsterByName(campaignId, finalName), 'Monster');
    },
};

const timelineSpec: EntityCrudSpec = {
    ...ENTITY_DELETE_SPECS.timeline,
    fields: [
        { key: 'description', type: 'longtext', required: true },
        { key: 'event_type', type: 'enum', values: TIMELINE_EVENT_TYPES },
        { key: 'year', type: 'int', min: -100_000, max: 100_000 },
    ],
    find: (campaignId, shortId) => asRow(worldRepository.getWorldEventByShortId(campaignId, shortId)),
    // No natural key: two events can have the same description.
    findByInput: () => null,
    create: (campaignId, input) => {
        const shortId = worldRepository.addWorldEvent(
            campaignId,
            null,
            pickRequired(input, 'description', ''),
            pickString(input, 'event_type') ?? 'GENERIC',
            typeof input.year === 'number' ? input.year : undefined,
            true,
        );
        if (!shortId) throw new BadRequestException('A world event with this description already exists');
        return reread(worldRepository.getWorldEventByShortId(campaignId, shortId), 'World event');
    },
    update: (campaignId, current, input) => {
        worldRepository.updateWorldEvent(current.id, {
            description: input.description !== undefined
                ? pickRequired(input, 'description', String(current.description))
                : undefined,
            event_type: input.event_type !== undefined
                ? (pickString(input, 'event_type') ?? undefined)
                : undefined,
            year: typeof input.year === 'number' ? input.year : undefined,
        });
        return reread(
            worldRepository.getWorldEventByShortId(campaignId, String(current.short_id)),
            'World event',
        );
    },
};

export const ENTITY_CRUD_SPECS: Record<CrudEntityType, EntityCrudSpec> = {
    npcs: npcSpec,
    locations: locationSpec,
    factions: factionSpec,
    quests: questSpec,
    inventory: inventorySpec,
    artifacts: artifactSpec,
    bestiary: bestiarySpec,
    timeline: timelineSpec,
};
