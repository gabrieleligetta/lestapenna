import {
    ReferenceContractError,
    buildVisualReferenceContract,
    imageModelCapabilities,
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
