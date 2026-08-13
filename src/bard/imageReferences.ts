import type { AIProvider } from '../config';

/**
 * The visual facts one reference is allowed to contribute.
 *
 * These names are deliberately provider-neutral. Gemini and OpenAI receive the
 * same semantic contract; only the binary transport differs in their adapters.
 */
export const REFERENCE_ROLES = [
    'whole_image',
    'subject_identity',
    'face',
    'body',
    'hair',
    'clothing',
    'armor_equipment',
    'pose_composition',
    'background',
    'style',
    'palette',
] as const;

export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

export const MAX_REFERENCE_INSTRUCTION_CHARS = 300;

/** Product ceiling. Provider-specific limits can be lower. */
export const MAX_REFERENCE_IMAGES = 6;

export interface ReferenceSelection {
    id: string;
    roles: ReferenceRole[];
    instruction: string | null;
    priority: number;
}

/** The immutable, auditable description frozen into a generation job. */
export interface ReferenceManifestEntry extends ReferenceSelection {
    label: string | null;
    scope: 'campaign' | 'faction' | 'entity' | 'scratch';
}

export class ReferenceContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReferenceContractError';
    }
}

const ROLE_INSTRUCTIONS: Record<ReferenceRole, string> = {
    whole_image: 'Use the complete visual design of this image, except for transformations stated explicitly below.',
    subject_identity: 'Preserve the identity and recognisable physical appearance of the subject.',
    face: 'Preserve the facial structure, proportions, features and distinguishing marks.',
    body: 'Preserve the build, proportions, limbs and other visible body characteristics.',
    hair: 'Preserve the hair colour, length, texture and style.',
    clothing: 'Preserve the garment design, cut, layers, materials and visible details.',
    armor_equipment: 'Preserve the armour, weapons, equipment, insignia and their design language.',
    pose_composition: 'Use the pose, camera angle, framing and composition.',
    background: 'Use the environment, architecture and background arrangement.',
    style: 'Use the artistic medium, rendering technique, texture and visual style.',
    palette: 'Use the colour relationships and palette.',
};

/** Defaults derived from where a picture is catalogued, never from AI analysis. */
export function defaultReferenceRoles(
    scope: 'campaign' | 'faction' | 'entity' | 'scratch',
): ReferenceRole[] {
    if (scope === 'campaign') return ['style'];
    if (scope === 'faction') return ['clothing', 'armor_equipment'];
    return ['subject_identity'];
}

export function parseStoredReferenceRoles(
    raw: string | null | undefined,
    fallback: ReferenceRole[],
): ReferenceRole[] {
    if (!raw) return [...fallback];
    try {
        return normalizeReferenceRoles(JSON.parse(raw));
    } catch {
        return [...fallback];
    }
}

export function normalizeReferenceRoles(raw: unknown): ReferenceRole[] {
    if (!Array.isArray(raw)) {
        throw new ReferenceContractError('Every selected reference needs at least one tag');
    }
    const roles = [...new Set(raw.map(value => {
        if (typeof value !== 'string' || !REFERENCE_ROLES.includes(value as ReferenceRole)) {
            throw new ReferenceContractError(`Unknown reference tag: ${String(value)}`);
        }
        return value as ReferenceRole;
    }))];
    if (roles.length === 0) {
        throw new ReferenceContractError('Every selected reference needs at least one tag');
    }
    if (roles.includes('whole_image') && roles.length > 1) {
        throw new ReferenceContractError('whole_image cannot be combined with other reference tags');
    }
    return roles;
}

export function normalizeReferenceInstruction(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') {
        throw new ReferenceContractError('Reference instructions must be text');
    }
    const value = raw.trim();
    if (value.length > MAX_REFERENCE_INSTRUCTION_CHARS) {
        throw new ReferenceContractError(
            `Reference instructions must not exceed ${MAX_REFERENCE_INSTRUCTION_CHARS} characters`,
        );
    }
    return value || null;
}

/**
 * Validates and canonicalises a client manifest.
 *
 * Priority is explicit at the API boundary, then converted into a dense 1..N
 * order. This keeps old clients (which only send ids) deterministic and stops
 * duplicate priorities from becoming an undocumented tie-breaker.
 */
export function normalizeReferenceSelections(
    raw: unknown,
    legacyIds: unknown,
): Array<Pick<ReferenceSelection, 'id'> & Partial<Omit<ReferenceSelection, 'id'>>> {
    const legacy = Array.isArray(legacyIds)
        ? legacyIds.map((id, index) => ({ id, priority: index + 1 }))
        : [];
    const source = raw === undefined ? legacy : raw;
    if (!Array.isArray(source)) {
        throw new ReferenceContractError('references must be an array');
    }
    if (source.length > MAX_REFERENCE_IMAGES) {
        throw new ReferenceContractError(`At most ${MAX_REFERENCE_IMAGES} reference images may be selected`);
    }

    const seenIds = new Set<string>();
    const seenPriorities = new Set<number>();
    const parsed = source.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            throw new ReferenceContractError('Every reference must be an object');
        }
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!id) throw new ReferenceContractError('Every reference needs an id');
        if (seenIds.has(id)) throw new ReferenceContractError(`Reference ${id} was selected twice`);
        seenIds.add(id);

        const priority = record.priority === undefined ? index + 1 : Number(record.priority);
        if (!Number.isInteger(priority) || priority < 1 || priority > MAX_REFERENCE_IMAGES) {
            throw new ReferenceContractError(`Reference priority must be between 1 and ${MAX_REFERENCE_IMAGES}`);
        }
        if (seenPriorities.has(priority)) {
            throw new ReferenceContractError('Reference priorities must be unique');
        }
        seenPriorities.add(priority);

        return {
            id,
            roles: record.roles === undefined ? undefined : normalizeReferenceRoles(record.roles),
            instruction: record.instruction === undefined
                ? undefined
                : normalizeReferenceInstruction(record.instruction),
            priority,
        };
    });

    return parsed
        .sort((a, b) => a.priority - b.priority)
        .map((entry, index) => ({ ...entry, priority: index + 1 }));
}

export function buildVisualReferenceContract(references: ReferenceManifestEntry[]): string {
    if (references.length === 0) return '';

    const entries = [...references]
        .sort((a, b) => a.priority - b.priority)
        .map((reference, index) => {
            const name = reference.label?.trim() || reference.scope;
            const defaults = reference.roles.map(role => ROLE_INSTRUCTIONS[role]).join(' ');
            const specific = reference.instruction
                ? `Specific instruction (highest priority): ${reference.instruction}`
                : 'No additional transformation instruction.';
            return [
                `Input image ${index + 1} (${name}).`,
                `Allowed roles: ${reference.roles.join(', ')}.`,
                defaults,
                specific,
                'Do not copy visual properties from this input that are not named by its allowed roles.',
            ].join(' ');
        });

    return [
        'VISUAL REFERENCE CONTRACT',
        'The attached input images are numbered in the order below.',
        'Resolve conflicts in this exact order: a reference-specific instruction; then the user description and shot controls; then the campaign appearance dossier; then the default behaviour of a reference role.',
        'A higher-priority input appears earlier. When two inputs claim the same role and their instructions do not resolve the conflict, follow the earlier input.',
        ...entries,
    ].join('\n');
}

export interface ImageModelCapabilities {
    supportsReferences: boolean;
    maxReferences: number;
    supportsIdentityReferences: boolean;
    maxIdentityReferences: number | null;
    maxStyleReferences: number | null;
    inputFidelity: 'automatic-high' | 'configurable' | 'unsupported';
}

const NO_REFERENCES: ImageModelCapabilities = {
    supportsReferences: false,
    maxReferences: 0,
    supportsIdentityReferences: false,
    maxIdentityReferences: 0,
    maxStyleReferences: 0,
    inputFidelity: 'unsupported',
};

/**
 * One capability matrix for HTTP validation, estimates and the runner.
 * Unknown model ids are intentionally conservative: a paid request must not be
 * the experiment that discovers whether its selected references were ignored.
 */
export function imageModelCapabilities(
    provider: AIProvider,
    model: string,
): ImageModelCapabilities {
    if (provider === 'openai') {
        if (model === 'gpt-image-2' || model.startsWith('gpt-image-2-')) {
            return {
                supportsReferences: true,
                maxReferences: MAX_REFERENCE_IMAGES,
                supportsIdentityReferences: true,
                maxIdentityReferences: null,
                maxStyleReferences: null,
                inputFidelity: 'automatic-high',
            };
        }
        if (model === 'gpt-image-1' || model === 'gpt-image-1.5') {
            return {
                supportsReferences: true,
                maxReferences: MAX_REFERENCE_IMAGES,
                supportsIdentityReferences: true,
                maxIdentityReferences: null,
                maxStyleReferences: null,
                inputFidelity: 'configurable',
            };
        }
        if (model === 'gpt-image-1-mini') {
            return {
                supportsReferences: true,
                maxReferences: MAX_REFERENCE_IMAGES,
                supportsIdentityReferences: true,
                maxIdentityReferences: null,
                maxStyleReferences: null,
                inputFidelity: 'unsupported',
            };
        }
        return NO_REFERENCES;
    }

    if (provider === 'gemini') {
        if (model === 'gemini-3-pro-image' || model.startsWith('gemini-3-pro-image-')) {
            return {
                supportsReferences: true,
                maxReferences: MAX_REFERENCE_IMAGES,
                supportsIdentityReferences: true,
                maxIdentityReferences: 5,
                maxStyleReferences: 3,
                inputFidelity: 'automatic-high',
            };
        }
        if (model === 'gemini-3.1-flash-image' || model.startsWith('gemini-3.1-flash-image-')) {
            return {
                supportsReferences: true,
                maxReferences: MAX_REFERENCE_IMAGES,
                supportsIdentityReferences: true,
                maxIdentityReferences: 4,
                maxStyleReferences: null,
                inputFidelity: 'automatic-high',
            };
        }
        if (model === 'gemini-2.5-flash-image' || model.startsWith('gemini-2.5-flash-image-')) {
            return {
                supportsReferences: true,
                maxReferences: 3,
                supportsIdentityReferences: true,
                maxIdentityReferences: 3,
                maxStyleReferences: null,
                inputFidelity: 'automatic-high',
            };
        }
        if (model === 'gemini-3.1-flash-lite-image' || model.startsWith('gemini-3.1-flash-lite-image-')) {
            return {
                supportsReferences: true,
                maxReferences: MAX_REFERENCE_IMAGES,
                supportsIdentityReferences: false,
                maxIdentityReferences: 0,
                maxStyleReferences: null,
                inputFidelity: 'automatic-high',
            };
        }
        // Imagen has no reference-image input in the adapter used by this app.
        return NO_REFERENCES;
    }

    return NO_REFERENCES;
}

const IDENTITY_ROLES = new Set<ReferenceRole>([
    'whole_image', 'subject_identity', 'face', 'body', 'hair',
]);

export function validateReferenceCapabilities(
    provider: AIProvider,
    model: string,
    references: Array<Pick<ReferenceManifestEntry, 'roles'>>,
): ImageModelCapabilities {
    const capabilities = imageModelCapabilities(provider, model);
    if (references.length === 0) return capabilities;
    if (!capabilities.supportsReferences) {
        throw new ReferenceContractError(`${model} cannot use reference images`);
    }
    if (references.length > capabilities.maxReferences) {
        throw new ReferenceContractError(
            `${model} accepts at most ${capabilities.maxReferences} reference images in this application`,
        );
    }

    const identityCount = references.filter(reference =>
        reference.roles.some(role => IDENTITY_ROLES.has(role))).length;
    if (identityCount > 0 && !capabilities.supportsIdentityReferences) {
        throw new ReferenceContractError(`${model} cannot preserve subject identity from a reference image`);
    }
    if (capabilities.maxIdentityReferences !== null && identityCount > capabilities.maxIdentityReferences) {
        throw new ReferenceContractError(
            `${model} accepts at most ${capabilities.maxIdentityReferences} identity references`,
        );
    }

    const styleCount = references.filter(reference => reference.roles.includes('style')).length;
    if (capabilities.maxStyleReferences !== null && styleCount > capabilities.maxStyleReferences) {
        throw new ReferenceContractError(
            `${model} accepts at most ${capabilities.maxStyleReferences} style references`,
        );
    }
    return capabilities;
}

export function needsHighInputFidelity(references: Array<Pick<ReferenceManifestEntry, 'roles'>>): boolean {
    return references.some(reference => reference.roles.some(role => IDENTITY_ROLES.has(role)));
}
