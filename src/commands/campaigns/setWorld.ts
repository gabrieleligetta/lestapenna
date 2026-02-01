
import { Command, CommandContext } from '../types';
import {
    factionRepository
} from '../../db';
import { startWorldConfigurationFlow } from '../utils/worldConfig';

export const setWorldCommand: Command = {
    name: 'setworld',
    aliases: ['configuramondo', 'mondo', 'setup-world'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const camp = ctx.activeCampaign!;
        const partyFaction = factionRepository.getPartyFaction(camp.id);

        // Always start the flow, allowing re-configuration
        await startWorldConfigurationFlow(ctx.message, camp.id, partyFaction);
    }
};
