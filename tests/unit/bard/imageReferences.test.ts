import {
    MAX_REFERENCE_LABEL_CHARS,
    REFERENCE_ROLES,
    REFERENCE_ROLES_BY_KIND,
    ReferenceContractError,
    buildVisualReferenceContract,
    imageModelCapabilities,
    normalizeReferenceLabel,
    normalizeReferenceRoles,
    normalizeReferenceSelections,
    validateReferenceCapabilities,
    type ReferenceManifestEntry,
} from '../../../src/bard/imageReferences';

const manifest = (roles: ReferenceManifestEntry['roles'], priority = 1): ReferenceManifestEntry => ({
    id: `media:${priority}`,
    scope: 'entity',
    label: `reference ${priority}`,
    roles,
    instruction: priority === 1 ? 'Keep the clothes, but make them white.' : null,
    priority,
});

describe('provider-neutral visual reference contract', () => {
    test('one image can carry several independent tags', () => {
        expect(normalizeReferenceRoles(['face', 'hair', 'clothing', 'face']))
            .toEqual(['face', 'hair', 'clothing']);
    });

    test('whole_image is deliberately exclusive', () => {
        expect(() => normalizeReferenceRoles(['whole_image', 'face']))
            .toThrow(ReferenceContractError);
    });

    test('freezes a dense, explicit priority order and rejects duplicates', () => {
        expect(normalizeReferenceSelections([
            { id: 'media:b', roles: ['style'], priority: 2 },
            { id: 'media:a', roles: ['face'], priority: 1 },
        ], undefined)).toEqual([
            { id: 'media:a', roles: ['face'], instruction: undefined, priority: 1 },
            { id: 'media:b', roles: ['style'], instruction: undefined, priority: 2 },
        ]);
        expect(() => normalizeReferenceSelections([
            { id: 'media:a', roles: ['face'], priority: 1 },
            { id: 'media:a', roles: ['style'], priority: 2 },
        ], undefined)).toThrow(/selected twice/);
    });

    test('states the required precedence and the per-image instruction', () => {
        const contract = buildVisualReferenceContract([
            manifest(['clothing', 'palette']),
            manifest(['subject_identity', 'face'], 2),
        ]);
        expect(contract).toContain('reference-specific instruction; then the user description and shot controls; then the campaign appearance dossier');
        expect(contract).toContain('Keep the clothes, but make them white.');
        expect(contract).toContain('Allowed roles: clothing, palette');
    });

    test('holds the note to one rule, whether it arrives with the upload or later', () => {
        expect(normalizeReferenceLabel('  the iron dames livery  ')).toBe('the iron dames livery');
        expect(normalizeReferenceLabel('   ')).toBeNull();
        expect(normalizeReferenceLabel(null)).toBeNull();
        expect(() => normalizeReferenceLabel('x'.repeat(MAX_REFERENCE_LABEL_CHARS + 1)))
            .toThrow(ReferenceContractError);
        expect(() => normalizeReferenceLabel(42)).toThrow(ReferenceContractError);
    });

    test('offers each kind of subject only the tags that can mean something', () => {
        for (const roles of Object.values(REFERENCE_ROLES_BY_KIND)) {
            expect(roles.every(role => REFERENCE_ROLES.includes(role))).toBe(true);
            // Without one of these a picture cannot be tagged at all.
            expect(roles).toEqual(expect.arrayContaining(['whole_image', 'subject_identity', 'style']));
        }
        expect(REFERENCE_ROLES_BY_KIND.place).not.toEqual(expect.arrayContaining(['hair', 'clothing']));
        expect(REFERENCE_ROLES_BY_KIND.place).toEqual(expect.arrayContaining(['architecture', 'landscape']));
        expect(REFERENCE_ROLES_BY_KIND.object).not.toEqual(expect.arrayContaining(['face', 'armor_equipment']));
        expect(REFERENCE_ROLES_BY_KIND.object).toEqual(expect.arrayContaining(['form', 'ornament', 'wear']));
    });

    test('a building and an artifact are named by their likeness, as a person is', () => {
        // Identity references are the ones asking for high input fidelity, and
        // a model that cannot preserve identity must refuse them all the same.
        for (const role of ['architecture', 'form'] as const) {
            expect(() => validateReferenceCapabilities(
                'gemini',
                'gemini-3.1-flash-lite-image',
                [manifest([role])],
            )).toThrow(/cannot preserve subject identity/);
        }
    });

    test('keeps provider limits in one conservative capability matrix', () => {
        expect(imageModelCapabilities('openai', 'gpt-image-2').inputFidelity).toBe('automatic-high');
        expect(imageModelCapabilities('gemini', 'gemini-2.5-flash-image').maxReferences).toBe(3);
        expect(() => validateReferenceCapabilities(
            'gemini',
            'gemini-2.5-flash-image',
            [manifest(['face'], 1), manifest(['face'], 2), manifest(['face'], 3), manifest(['style'], 4)],
        )).toThrow(/at most 3/);
        expect(() => validateReferenceCapabilities(
            'gemini',
            'imagen-4.0-generate-001',
            [manifest(['style'])],
        )).toThrow(/cannot use reference images/);
    });
});
