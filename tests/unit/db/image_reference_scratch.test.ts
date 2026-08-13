import { createCampaign, deleteCampaign } from '../../../src/db';
import { scratchReferenceRepository } from '../../../src/db/repositories/ScratchReferenceRepository';
import { aiJobRepository } from '../../../src/db/repositories/AiJobRepository';

describe('durable one-time image references', () => {
    let campaignId: number;

    beforeAll(() => {
        campaignId = createCampaign('Scratch references', `scratch-${process.pid}`);
    });

    afterAll(() => {
        deleteCampaign(campaignId);
    });

    test('survives process memory and can be attached to only one job', () => {
        const firstJob = aiJobRepository.enqueue({
            campaignId,
            kind: 'image',
            targetType: 'npc',
            targetKey: 'first',
            targetLabel: null,
            requestedBy: 'u1',
            params: {},
        });
        const secondJob = aiJobRepository.enqueue({
            campaignId,
            kind: 'image',
            targetType: 'npc',
            targetKey: 'second',
            targetLabel: null,
            requestedBy: 'u1',
            params: {},
        });
        const reference = scratchReferenceRepository.add({
            campaign_id: campaignId,
            object_key: `references/${campaignId}/scratch/test.webp`,
            mime_type: 'image/webp',
            width: 10,
            height: 10,
            size_bytes: 20,
            label: 'temporary face',
            roles_json: '["subject_identity","face"]',
            instruction: 'Keep the same face.',
            uploaded_by: 'u1',
            expires_at: Date.now() + 60_000,
        });

        expect(scratchReferenceRepository.getById(campaignId, reference.id)).toMatchObject({
            object_key: reference.object_key,
            job_id: null,
        });
        expect(scratchReferenceRepository.attachManyToJob(
            campaignId,
            [reference.id],
            firstJob.id,
            Date.now() + 120_000,
        )).toBe(true);
        expect(scratchReferenceRepository.attachManyToJob(
            campaignId,
            [reference.id],
            secondJob.id,
            Date.now() + 120_000,
        )).toBe(false);

        expect(scratchReferenceRepository.remove(campaignId, reference.id)?.job_id).toBe(firstJob.id);
        expect(scratchReferenceRepository.getById(campaignId, reference.id)).toBeNull();
    });
});
