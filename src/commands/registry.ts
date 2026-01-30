import { CommandDispatcher } from './index';

// Admin
import { wipeCommand } from './admin/wipe';
import { reprocessCommand } from './admin/reprocess';
import { debugCommand } from './admin/debug';
import { rebuildCommand } from './admin/rebuild';
import { recoverCommand } from './admin/recover';

// Campaigns
import { createCampaignCommand } from './campaigns/create';
import { deleteCampaignCommand } from './campaigns/delete';
import { listCampaignsCommand } from './campaigns/list';
import { selectCampaignCommand } from './campaigns/select';

// Characters
import { bioCommand } from './characters/bio';
import { iamCommand } from './characters/iam';
import { myclassCommand } from './characters/myclass';
import { mydescCommand } from './characters/mydesc';
import { myraceCommand } from './characters/myrace';
import { partyCommand } from './characters/party';
import { resetCharacterCommand } from './characters/reset';
import { whoamiCommand } from './characters/whoami';

// Config
import { setCommand } from './config/set';
import { statusCommand } from './config/status';
import { metricsCommand } from './config/metrics';
import { autoupdateCommand } from './config/autoupdate';

// Help
import { aiutoCommand } from './help/aiuto';
import { helpCommand } from './help/help';

// Inventory
import { bestiaryCommand } from './inventory/bestiary';
import { inventoryCommand } from './inventory/inventory';
import { questCommand } from './inventory/quest';

// Locations
import { atlasCommand } from './locations/atlas';
import { locationCommand } from './locations/location';
import { travelsCommand } from './locations/travels';

// Narrative
import { askCommand } from './narrative/ask';
import { ingestCommand } from './narrative/ingest';
import { narrateCommand } from './narrative/narrate';
import { storyCommand } from './narrative/story';
import { wikiCommand } from './narrative/wiki';

// NPCs
import { npcCommand } from './npcs/npc';
import { presenzeCommand } from './npcs/presenze';

// Factions
import { factionCommand } from './factions/faction';
import { affiliateCommand } from './factions/affiliate';

// Sessions
import { downloadCommand } from './sessions/download';
import { listCommand as listSessionsCommand } from './sessions/list'; // Renaming to avoid conflict if imported same way, though locally protected.
import { listenCommand } from './sessions/listen';
import { manageCommand } from './sessions/manage';
import { noteCommand } from './sessions/note';
import { pauseCommand } from './sessions/pause';
import { resetCommand as resetSessionCommand } from './sessions/reset';
import { stopCommand } from './sessions/stop';

// Timeline
import { dateCommand } from './timeline/date';
import { timelineCommand } from './timeline/timeline';
import { year0Command } from './timeline/year0';

export function registerAllCommands(dispatcher: CommandDispatcher) {
    // Admin
    dispatcher.register(wipeCommand);
    dispatcher.register(reprocessCommand);
    dispatcher.register(debugCommand);
    dispatcher.register(rebuildCommand);
    dispatcher.register(recoverCommand);

    // Campaigns
    dispatcher.register(createCampaignCommand);
    dispatcher.register(deleteCampaignCommand);
    dispatcher.register(listCampaignsCommand);
    dispatcher.register(selectCampaignCommand);

    // Characters
    dispatcher.register(bioCommand);
    dispatcher.register(iamCommand);
    dispatcher.register(myclassCommand);
    dispatcher.register(mydescCommand);
    dispatcher.register(myraceCommand);
    dispatcher.register(partyCommand);
    dispatcher.register(resetCharacterCommand);
    dispatcher.register(whoamiCommand);

    // Config
    dispatcher.register(setCommand);
    dispatcher.register(statusCommand);
    dispatcher.register(metricsCommand);
    dispatcher.register(autoupdateCommand);

    // Help
    dispatcher.register(aiutoCommand);
    dispatcher.register(helpCommand);

    // Inventory
    dispatcher.register(bestiaryCommand);
    dispatcher.register(inventoryCommand);
    dispatcher.register(questCommand);

    // Locations
    dispatcher.register(atlasCommand);
    dispatcher.register(locationCommand);
    dispatcher.register(travelsCommand);

    // Narrative
    dispatcher.register(askCommand);
    dispatcher.register(ingestCommand);
    dispatcher.register(narrateCommand);
    dispatcher.register(storyCommand);
    dispatcher.register(wikiCommand);

    // NPCs
    dispatcher.register(npcCommand);
    dispatcher.register(presenzeCommand);

    // Factions
    dispatcher.register(factionCommand);
    dispatcher.register(affiliateCommand);

    // Sessions
    dispatcher.register(downloadCommand);
    dispatcher.register(listSessionsCommand);
    dispatcher.register(listenCommand);
    dispatcher.register(manageCommand);
    dispatcher.register(noteCommand);
    dispatcher.register(pauseCommand);
    dispatcher.register(resetSessionCommand);
    dispatcher.register(stopCommand);

    // Timeline
    dispatcher.register(dateCommand);
    dispatcher.register(timelineCommand);
    dispatcher.register(year0Command);
}
