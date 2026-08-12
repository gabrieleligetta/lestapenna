import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { reconcileNpcName } from '../../../src/bard/reconciliation/npc';
import { getAllNpcs } from '../../../src/db';
import { getMetadataClient } from '../../../src/bard/config';

jest.mock('../../../src/db', () => ({
    getAllNpcs: jest.fn(),
    getCampaignCharacters: jest.fn().mockReturnValue([]),
    npcRepository: {
        getNpcByShortId: jest.fn()
    }
}));

jest.mock('../../../src/bard/rag', () => ({
    searchKnowledge: jest.fn(async () => [])
}));

jest.mock('../../../src/bard/config', () => ({
    getMetadataClient: jest.fn().mockReturnValue({
        client: {
            chat: {
                completions: {
                    create: jest.fn()
                }
            }
        },
        model: 'test-model'
    })
}));

describe('NPC article-insensitive reconciliation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (getAllNpcs as jest.Mock).mockReturnValue([
            { id: 416, name: 'Dama Bianca', description: 'Entità delle rovine' }
        ]);
    });

    it('matches a canonical NPC when the detected name has a leading article', async () => {
        const result = await reconcileNpcName(2, 'La Dama Bianca', 'Entità delle rovine');

        expect(result).not.toBeNull();
        expect(result?.canonicalName).toBe('Dama Bianca');

        const metadata = getMetadataClient() as any;
        expect(metadata.client.chat.completions.create).not.toHaveBeenCalled();
    });
});
