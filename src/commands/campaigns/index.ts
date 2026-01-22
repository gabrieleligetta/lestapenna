/**
 * Campaign commands index
 */

export { createCampaignCommand } from './create';
export { listCampaignsCommand } from './list';
export { selectCampaignCommand } from './select';
export { deleteCampaignCommand } from './delete';

import { Command } from '../types';
import { createCampaignCommand } from './create';
import { listCampaignsCommand } from './list';
import { selectCampaignCommand } from './select';
import { deleteCampaignCommand } from './delete';

export const campaignCommands: Command[] = [
    createCampaignCommand,
    listCampaignsCommand,
    selectCampaignCommand,
    deleteCampaignCommand
];
