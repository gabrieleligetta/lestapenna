import { BadRequestException } from '@nestjs/common';

/**
 * Declarative schema of an entity's editable fields.
 *
 * Quests have a hand-written `parseQuestMutation`; replicating it for another
 * seven families would mean seven near-identical functions in which a forgotten
 * length limit goes unnoticed. Here the shape of the field is the data, and
 * validation is a single function — the same one the web editor mirrors in its
 * registry.
 */
export type CrudFieldType = 'text' | 'longtext' | 'enum' | 'int' | 'bool' | 'stringList';

export interface CrudFieldSpec {
    key: string;
    type: CrudFieldType;
    /** Required on create; on update it cannot be emptied. */
    required?: boolean;
    maxLength?: number;
    /** Only for `enum`. */
    values?: readonly string[];
    /** Only for `int`. */
    min?: number;
    max?: number;
    /** Only for `stringList`: the maximum number of entries. */
    maxItems?: number;
}

export type CrudFieldValue = string | number | boolean | string[] | null;
export type CrudInput = Record<string, CrudFieldValue>;

const DEFAULT_TEXT_MAX = 200;
const DEFAULT_LONGTEXT_MAX = 12000;

function fail(field: string, detail: string): never {
    throw new BadRequestException(`${field} ${detail}`);
}

function parseText(spec: CrudFieldSpec, raw: unknown): string | null {
    if (typeof raw !== 'string') fail(spec.key, 'must be a string');
    const value = (raw as string).trim();
    const max = spec.maxLength ?? (spec.type === 'longtext' ? DEFAULT_LONGTEXT_MAX : DEFAULT_TEXT_MAX);
    if (value.length > max) fail(spec.key, `must be at most ${max} characters`);
    return value.length > 0 ? value : null;
}

function parseStringList(spec: CrudFieldSpec, raw: unknown): string[] {
    // The editor sends an array; legacy records hold the same data as
    // JSON or as a comma-separated list, and both have to be accepted.
    let items: unknown[];
    if (Array.isArray(raw)) {
        items = raw;
    } else if (typeof raw === 'string') {
        const text = raw.trim();
        if (!text) return [];
        if (text.startsWith('[')) {
            try {
                const parsed = JSON.parse(text);
                items = Array.isArray(parsed) ? parsed : [text];
            } catch {
                items = text.split(',');
            }
        } else {
            items = text.split(',');
        }
    } else {
        fail(spec.key, 'must be a list of strings');
    }

    const values = items
        .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
        .filter((item) => item.length > 0);
    const max = spec.maxLength ?? DEFAULT_TEXT_MAX;
    if (values.some((item) => item.length > max)) {
        fail(spec.key, `entries must be at most ${max} characters`);
    }
    if (spec.maxItems && values.length > spec.maxItems) {
        fail(spec.key, `must have at most ${spec.maxItems} entries`);
    }
    return values;
}

function parseValue(spec: CrudFieldSpec, raw: unknown): CrudFieldValue {
    switch (spec.type) {
        case 'text':
        case 'longtext':
            return parseText(spec, raw);

        case 'enum': {
            const values = spec.values ?? [];
            if (typeof raw !== 'string' || !values.includes(raw)) {
                fail(spec.key, `must be one of: ${values.join(', ')}`);
            }
            return raw as string;
        }

        case 'int': {
            const value = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isFinite(value) || !Number.isInteger(value)) {
                fail(spec.key, 'must be an integer');
            }
            if (spec.min !== undefined && value < spec.min) fail(spec.key, `must be at least ${spec.min}`);
            if (spec.max !== undefined && value > spec.max) fail(spec.key, `must be at most ${spec.max}`);
            return value;
        }

        case 'bool':
            if (typeof raw === 'boolean') return raw;
            if (raw === 1 || raw === 0) return raw === 1;
            fail(spec.key, 'must be a boolean');
            break;

        case 'stringList':
            return parseStringList(spec, raw);
    }
}

/**
 * Validates the body of a create/update against the field schema.
 *
 * `mode: 'create'` demands the required fields; `mode: 'update'` is a patch —
 * absent fields stay unchanged, but a required field present and empty is an
 * error, not a way of clearing it.
 */
export function parseCrudInput(
    fields: readonly CrudFieldSpec[],
    body: unknown,
    mode: 'create' | 'update',
): CrudInput {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new BadRequestException('Request body must be an object');
    }
    const source = body as Record<string, unknown>;

    const known = new Set(fields.map((field) => field.key));
    const unknownKeys = Object.keys(source).filter((key) => !known.has(key));
    if (unknownKeys.length > 0) {
        throw new BadRequestException(`Unknown fields: ${unknownKeys.join(', ')}`);
    }

    const input: CrudInput = {};
    for (const spec of fields) {
        const raw = source[spec.key];
        const provided = raw !== undefined;

        if (!provided) {
            if (mode === 'create' && spec.required) fail(spec.key, 'is required');
            continue;
        }

        if (raw === null) {
            if (spec.required) fail(spec.key, 'is required');
            input[spec.key] = null;
            continue;
        }

        const value = parseValue(spec, raw);
        if (spec.required && (value === null || (Array.isArray(value) && value.length === 0))) {
            fail(spec.key, 'is required');
        }
        input[spec.key] = value;
    }

    if (mode === 'update' && Object.keys(input).length === 0) {
        throw new BadRequestException('No editable fields were provided');
    }
    return input;
}

/** The value, or `fallback` when the patch does not touch that field. */
export function pickString(input: CrudInput, key: string, fallback: string | null = null): string | null {
    const value = input[key];
    if (value === undefined) return fallback;
    return value === null ? null : String(value);
}

export function pickRequired(input: CrudInput, key: string, fallback: string): string {
    const value = pickString(input, key, fallback);
    return value ?? fallback;
}
