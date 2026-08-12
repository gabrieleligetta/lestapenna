import type { CrudEntityType, EntityRow } from '../api/types';
import type { Messages } from '../i18n/messages';

/**
 * The editable fields of each entity family.
 *
 * Mirrors `src/api/campaigns/crud/entity-crud.registry.ts`: same names,
 * same limits, same enums. It is a deliberate, local duplication — the same
 * choice already made for the columns in entityConfig.tsx — because the backend
 * validates everything anyway: the copy here only serves to build the form and
 * to give an error before the round-trip.
 */
export type FormFieldType = 'text' | 'longtext' | 'enum' | 'int' | 'bool' | 'stringList';

export interface FormFieldSpec {
    key: string;
    type: FormFieldType;
    /** i18n key of the label. */
    labelKey: keyof Messages['fields'];
    required?: boolean;
    maxLength?: number;
    values?: readonly string[];
    min?: number;
    max?: number;
    /** Textarea rows; only for `longtext`. */
    rows?: number;
}

const NPC_STATUSES = ['ALIVE', 'DEAD', 'MISSING'] as const;
const BESTIARY_STATUSES = ['ALIVE', 'DEFEATED', 'FLED'] as const;
const ARTIFACT_STATUSES = ['FUNCTIONAL', 'DESTROYED', 'LOST', 'SEALED', 'DORMANT'] as const;
const FACTION_TYPES = ['GUILD', 'KINGDOM', 'CULT', 'ORGANIZATION', 'GENERIC'] as const;
const FACTION_STATUSES = ['ACTIVE', 'DISBANDED', 'DESTROYED'] as const;
const QUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED'] as const;
const QUEST_TYPES = ['MAJOR', 'MINOR'] as const;
const INVENTORY_CATEGORIES = [
    'WEAPON', 'ARMOR', 'CONSUMABLE', 'TOOL', 'MATERIAL', 'TREASURE', 'QUEST_ITEM', 'OTHER',
] as const;
export const TIMELINE_EVENT_TYPES = [
    'WAR', 'POLITICS', 'DISCOVERY', 'CALAMITY', 'DISASTER', 'SUPERNATURAL',
    'RELIGION', 'MYTH', 'BIRTH', 'DEATH', 'CONSTRUCTION', 'GENERIC',
] as const;

export const ENTITY_FORM_FIELDS: Record<CrudEntityType, readonly FormFieldSpec[]> = {
    npcs: [
        { key: 'name', type: 'text', labelKey: 'name', required: true, maxLength: 160 },
        { key: 'status', type: 'enum', labelKey: 'status', values: NPC_STATUSES },
        { key: 'role', type: 'text', labelKey: 'role', maxLength: 120 },
        { key: 'description', type: 'longtext', labelKey: 'description', rows: 7 },
        { key: 'aliases', type: 'stringList', labelKey: 'aliases' },
    ],
    locations: [
        { key: 'macro_location', type: 'text', labelKey: 'region', required: true, maxLength: 160 },
        { key: 'micro_location', type: 'text', labelKey: 'place', required: true, maxLength: 160 },
        { key: 'description', type: 'longtext', labelKey: 'description', rows: 7 },
    ],
    factions: [
        { key: 'name', type: 'text', labelKey: 'name', required: true, maxLength: 160 },
        { key: 'type', type: 'enum', labelKey: 'type', values: FACTION_TYPES },
        { key: 'status', type: 'enum', labelKey: 'status', values: FACTION_STATUSES },
        { key: 'description', type: 'longtext', labelKey: 'description', rows: 7 },
    ],
    quests: [
        { key: 'title', type: 'text', labelKey: 'title', required: true, maxLength: 160 },
        { key: 'status', type: 'enum', labelKey: 'status', required: true, values: QUEST_STATUSES },
        { key: 'type', type: 'enum', labelKey: 'type', required: true, values: QUEST_TYPES },
        { key: 'description', type: 'longtext', labelKey: 'description', rows: 7 },
    ],
    inventory: [
        { key: 'item_name', type: 'text', labelKey: 'item', required: true, maxLength: 160 },
        { key: 'quantity', type: 'int', labelKey: 'quantity', min: 0, max: 1000000 },
        { key: 'category', type: 'enum', labelKey: 'type', values: INVENTORY_CATEGORIES },
        { key: 'description', type: 'longtext', labelKey: 'description', rows: 6 },
        { key: 'notes', type: 'longtext', labelKey: 'notes', rows: 3, maxLength: 4000 },
    ],
    artifacts: [
        { key: 'name', type: 'text', labelKey: 'name', required: true, maxLength: 160 },
        { key: 'status', type: 'enum', labelKey: 'status', values: ARTIFACT_STATUSES },
        { key: 'description', type: 'longtext', labelKey: 'description', rows: 6 },
        { key: 'effects', type: 'longtext', labelKey: 'effects', rows: 3, maxLength: 4000 },
        { key: 'is_cursed', type: 'bool', labelKey: 'curse' },
        { key: 'curse_description', type: 'longtext', labelKey: 'curse', rows: 3, maxLength: 4000 },
        { key: 'owner_name', type: 'text', labelKey: 'owner', maxLength: 160 },
        { key: 'location_macro', type: 'text', labelKey: 'region', maxLength: 160 },
        { key: 'location_micro', type: 'text', labelKey: 'place', maxLength: 160 },
    ],
    bestiary: [
        { key: 'name', type: 'text', labelKey: 'name', required: true, maxLength: 160 },
        { key: 'status', type: 'enum', labelKey: 'status', values: BESTIARY_STATUSES },
        { key: 'description', type: 'longtext', labelKey: 'description', rows: 6 },
        { key: 'abilities', type: 'stringList', labelKey: 'abilities' },
        { key: 'weaknesses', type: 'stringList', labelKey: 'weaknesses' },
        { key: 'resistances', type: 'stringList', labelKey: 'resistances' },
        { key: 'notes', type: 'longtext', labelKey: 'notes', rows: 3, maxLength: 4000 },
    ],
    timeline: [
        { key: 'description', type: 'longtext', labelKey: 'description', required: true, rows: 5 },
        { key: 'event_type', type: 'enum', labelKey: 'type', values: TIMELINE_EVENT_TYPES },
        { key: 'year', type: 'int', labelKey: 'year', min: -100000, max: 100000 },
    ],
};

/** A field's value as the form handles it: always a string. */
export type FormValues = Record<string, string>;

/** Lists arrive as an array or as serialized JSON, depending on the row's age. */
function listToText(value: unknown): string {
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value !== 'string') return '';
    const text = value.trim();
    if (!text.startsWith('[')) return text;
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.join(', ') : text;
    } catch {
        return text;
    }
}

/** Pre-fills the form from the existing row; a create starts empty. */
export function toFormValues(
    fields: readonly FormFieldSpec[],
    row: EntityRow | null | undefined,
): FormValues {
    const values: FormValues = {};
    for (const field of fields) {
        const raw = row?.[field.key];
        if (field.type === 'stringList') {
            values[field.key] = listToText(raw);
        } else if (field.type === 'bool') {
            values[field.key] = Number(raw) === 1 || raw === true ? 'true' : 'false';
        } else if (raw === null || raw === undefined) {
            // An enum with no value starts from the first option, otherwise the
            // select would show an empty entry that cannot be saved.
            values[field.key] = field.type === 'enum' ? (field.values?.[0] ?? '') : '';
        } else {
            values[field.key] = String(raw);
        }
    }
    return values;
}

/**
 * Converts the form's values into the request body.
 *
 * A text field left empty becomes `null`, which the backend reads as "clear
 * this field"; an empty integer is omitted, because `0` and "not given" are
 * different things for a quantity or for a year.
 */
export function toMutationBody(
    fields: readonly FormFieldSpec[],
    values: FormValues,
): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const field of fields) {
        const raw = (values[field.key] ?? '').trim();
        switch (field.type) {
            case 'bool':
                body[field.key] = raw === 'true';
                break;
            case 'int':
                if (raw === '') break;
                body[field.key] = Number(raw);
                break;
            case 'stringList':
                body[field.key] = raw
                    ? raw.split(',').map((item) => item.trim()).filter(Boolean)
                    : [];
                break;
            case 'enum':
                if (raw) body[field.key] = raw;
                break;
            default:
                body[field.key] = raw === '' ? null : raw;
        }
    }
    return body;
}

/** The first blocking error, or null. The backend revalidates everything anyway. */
export function firstFormError(
    fields: readonly FormFieldSpec[],
    values: FormValues,
    t: Messages,
): string | null {
    for (const field of fields) {
        const raw = (values[field.key] ?? '').trim();
        if (field.required && !raw) return t.crud.fieldRequired(t.fields[field.labelKey]);
        if (field.maxLength && raw.length > field.maxLength) {
            return t.crud.fieldTooLong(t.fields[field.labelKey], field.maxLength);
        }
        if (field.type === 'int' && raw !== '') {
            const value = Number(raw);
            if (!Number.isInteger(value)) return t.crud.fieldNotInteger(t.fields[field.labelKey]);
            if (field.min !== undefined && value < field.min) {
                return t.crud.fieldOutOfRange(t.fields[field.labelKey], field.min, field.max ?? value);
            }
            if (field.max !== undefined && value > field.max) {
                return t.crud.fieldOutOfRange(t.fields[field.labelKey], field.min ?? value, field.max);
            }
        }
    }
    return null;
}
