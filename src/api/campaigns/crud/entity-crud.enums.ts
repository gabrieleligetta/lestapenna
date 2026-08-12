/**
 * The values accepted by the enum fields of the entity CRUD.
 *
 * Quests and inventory already have their canonical list in db/types.ts and it
 * is re-exported from here, so the web editor has a single source to mirror.
 * The other types existed only as TypeScript unions or as a comment in the
 * schema: without a runtime array there is nothing to validate, nor to show
 * in a dropdown.
 */
export { INVENTORY_CATEGORIES, QUEST_TYPES } from '../../../db/types';
export { QUEST_STATUSES } from '../../../db/types';

/** `npc_dossier.status` — vedi schema.ts. */
export const NPC_STATUSES = ['ALIVE', 'DEAD', 'MISSING'] as const;

/** `bestiary.status` — the implicit order of the lists is ALIVE → FLED → DEFEATED. */
export const BESTIARY_STATUSES = ['ALIVE', 'DEFEATED', 'FLED'] as const;

/** `artifacts.status` — speculare a ArtifactStatus in db/types.ts. */
export const ARTIFACT_STATUSES = ['FUNCTIONAL', 'DESTROYED', 'LOST', 'SEALED', 'DORMANT'] as const;

/** `factions.type` — mirrors FactionType. PARTY is not selectable by hand:
 *  the party faction is unique per campaign and the bot creates it. */
export const FACTION_TYPES = ['GUILD', 'KINGDOM', 'CULT', 'ORGANIZATION', 'GENERIC'] as const;

/** `factions.status` — speculare a FactionStatus. */
export const FACTION_STATUSES = ['ACTIVE', 'DISBANDED', 'DESTROYED'] as const;

/**
 * `world_history.event_type`. A superset of the six values of the
 * WorldHistoryEntry union: the timeline renderer (bot and web) has long had
 * icons for DISASTER/MYTH/RELIGION/BIRTH/DEATH/CONSTRUCTION too, and the
 * production data contains them.
 */
export const TIMELINE_EVENT_TYPES = [
    'WAR',
    'POLITICS',
    'DISCOVERY',
    'CALAMITY',
    'DISASTER',
    'SUPERNATURAL',
    'RELIGION',
    'MYTH',
    'BIRTH',
    'DEATH',
    'CONSTRUCTION',
    'GENERIC',
] as const;

/**
 * The `event_type` values accepted on hand-editable history rows.
 *
 * The bot writes per-domain values (REVELATION, BETRAYAL, LOOT, …) and renders
 * them with dedicated icons; a per-family dropdown would be eight lists to keep
 * aligned. The web editor accepts the row's existing value plus this neutral
 * set, so an AI-generated event does not lose its type when someone corrects
 * only its description.
 */
export const MANUAL_EVENT_TYPES = ['NOTE', 'MANUAL_UPDATE', 'GENERIC', 'OBSERVATION'] as const;
