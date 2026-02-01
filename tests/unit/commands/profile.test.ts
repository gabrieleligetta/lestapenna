
import { iamCommand } from '../../../src/commands/characters/iam';
import { CommandContext } from '../../../src/commands/types';

// Mock DB and Repositories
jest.mock('../../../src/db', () => ({
    updateUserCharacter: jest.fn(),
    getUserProfile: jest.fn().mockReturnValue({
        character_name: 'Test Hero',
        race: 'Human',
        class: 'Warrior',
        alignment_moral: 'NEUTRALE',
        alignment_ethical: 'NEUTRALE',
        description: 'A test character',
        foundation_description: null,
        email: null
    }),
    db: {
        prepare: jest.fn().mockReturnValue({
            get: jest.fn().mockReturnValue({ rowid: 1 }),
            run: jest.fn()
        })
    },
    factionRepository: {
        getPartyFaction: jest.fn().mockReturnValue({ id: 1 }),
        addAffiliation: jest.fn()
    },
    characterRepository: {
        updateFoundationDescription: jest.fn(),
        updateCharacterAlignment: jest.fn()
    }
}));

import * as db from '../../../src/db';

describe('Profile Command (Unified $iam)', () => {
    let mockContext: CommandContext;
    let replyMock: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        replyMock = jest.fn().mockResolvedValue({
            createMessageComponentCollector: jest.fn().mockReturnValue({
                on: jest.fn(),
                stop: jest.fn()
            })
        });

        mockContext = {
            message: {
                reply: replyMock,
                author: { id: 'user-123' },
            } as any,
            args: [],
            guildId: 'guild-456',
            activeCampaign: { id: 1, name: 'Test Campaign' } as any,
            client: {} as any,
        };
    });

    it('should handle DM special case', async () => {
        mockContext.args = ['DM'];

        await iamCommand.execute(mockContext);

        expect(db.updateUserCharacter).toHaveBeenCalledWith('user-123', 1, 'character_name', 'DM');
        expect(db.updateUserCharacter).toHaveBeenCalledWith('user-123', 1, 'class', 'Dungeon Master');
        expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Saluti, Dungeon Master'));
    });

    it('should update name immediately if provided in args', async () => {
        mockContext.args = ['Grog'];

        await iamCommand.execute(mockContext);

        expect(db.updateUserCharacter).toHaveBeenCalledWith('user-123', 1, 'character_name', 'Grog');
        expect(db.factionRepository.getPartyFaction).toHaveBeenCalledWith(1);
        expect(db.factionRepository.addAffiliation).toHaveBeenCalled();
        expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
            embeds: expect.any(Array),
            components: expect.any(Array)
        }));
    });

    it('should show dashboard if no args provided', async () => {
        mockContext.args = [];

        await iamCommand.execute(mockContext);

        expect(db.updateUserCharacter).not.toHaveBeenCalled();
        expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
            embeds: expect.any(Array),
            components: expect.any(Array)
        }));
    });
});
