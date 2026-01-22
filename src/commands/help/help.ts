/**
 * $help command - English help
 */

import { EmbedBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';

export const helpCommand: Command = {
    name: 'help',
    aliases: [],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const helpEmbed = new EmbedBuilder()
            .setTitle("🖋️ Lestapenna - Available Commands")
            .setColor("#D4AF37")
            .setDescription("Welcome, adventurers! I am your personal bard and chronicler.")
            .addFields(
                {
                    name: "🗺️ Campaigns",
                    value:
                        "`$createcampaign <Name>`: Create a new campaign.\n" +
                        "`$selectcampaign <Name>`: Activate a campaign.\n" +
                        "`$listcampaigns`: Show available campaigns.\n" +
                        "`$deletecampaign <Name>`: Delete a campaign."
                },
                {
                    name: "🎙️ Session Management",
                    value:
                        "`$listen [Location]`: Start recording (Active Campaign).\n" +
                        "`$stoplistening`: End the session.\n" +
                        "`$pause`: Pause recording.\n" +
                        "`$resume`: Resume recording.\n" +
                        "`$note <Text>`: Add a manual note to the summary.\n" +
                        "`$setsession <N>`: Manually set session number.\n" +
                        "`$reset <ID>`: Force re-processing of a session."
                },
                {
                    name: "🕰️ Session Specific Commands",
                    value: "Many commands accept a session ID (`session_xxxxx` or UUID) to view history:\n" +
                           "`$travels <ID>`: Session travels.\n" +
                           "`$presenze <ID>`: Encountered NPCs.\n" +
                           "`$npc <ID>`: NPC preview.\n" +
                           "`$atlas <ID>`: Visited locations.\n" +
                           "`$inventory <ID>`: Acquired items.\n" +
                           "`$quest <ID>`: Added quests."
                },
                {
                    name: "📍 Locations & Atlas",
                    value:
                        "`$location [Macro | Micro]`: View or update location.\n" +
                        "`$travels`: Travel history.\n" +
                        "`$travels fix #ID | <R> | <L>`: Fix history entry.\n" +
                        "`$atlas`: Current location memory.\n" +
                        "`$atlas list`: List all locations.\n" +
                        "`$atlas rename <OR>|<OL>|<NR>|<NL>`: Rename location.\n" +
                        "`$atlas <R> | <L> | <Desc> [| force]`: Update.\n" +
                        "`$atlas sync [all|Name]`: Sync RAG."
                },
                {
                    name: "👥 NPC & Dossier",
                    value:
                        "`$npc [Name]`: View or update NPC dossier.\n" +
                        "`$npc add <Name> | <Role> | <Desc>`: Create a new NPC.\n" +
                        "`$npc merge <Old> | <New>`: Merge two NPCs.\n" +
                        "`$npc delete <Name>`: Delete an NPC.\n" +
                        "`$npc update <Name> | <Field> | <Val> [| force]`: Update fields.\n" +
                        "`$npc regen <Name>`: Regenerate notes using history.\n" +
                        "`$npc sync [Name|all]`: Manually sync RAG.\n" +
                        "`$presenze`: Show NPCs encountered in session."
                },
                {
                    name: "📜 Storytelling & Archives",
                    value:
                        "`$listsessions`: Last 5 sessions (Active Campaign).\n" +
                        "`$narrate <ID> [tone]`: Regenerate summary.\n" +
                        "`$edittitle <ID> <Title>`: Edit session title.\n" +
                        "`$ask <Question>`: Ask the Bard about the lore.\n" +
                        "`$lore <Term>`: Search exact lore fragments.\n" +
                        "`$timeline`: Show world history timeline.\n" +
                        "`$ingest <ID>`: Manually index a session into memory.\n" +
                        "`$download <ID>`: Download audio.\n" +
                        "`$downloadtxt <ID>`: Download transcriptions (txt)."
                },
                {
                    name: "🐲 Bestiary",
                    value:
                        "`$bestiario`: Show encountered monsters.\n" +
                        "`$bestiario <Name>`: Monster details (abilities, weaknesses, etc.).\n" +
                        "`$bestiario merge <Old> | <New>`: Merge two monsters."
                },
                {
                    name: "🎒 Inventory & Quests",
                    value:
                        "`$quest`: View active quests.\n" +
                        "`$quest add <Title>`: Add a quest.\n" +
                        "`$quest done <Title>`: Complete a quest.\n" +
                        "`$quest delete <ID>`: Delete a quest.\n" +
                        "`$inventory`: View inventory.\n" +
                        "`$loot add <Item>`: Add an item.\n" +
                        "`$loot use <Item>`: Remove/Use an item.\n" +
                        "`$mergeitem <Old> | <New>`: Merge two items.\n" +
                        "`$mergequest <Old> | <New>`: Merge two quests."
                },
                {
                    name: "👤 Character Sheet (Active Campaign)",
                    value:
                        "`$iam <Name>`: Set your character name.\n" +
                        "`$myclass <Class>`: Set your class.\n" +
                        "`$myrace <Race>`: Set your race.\n" +
                        "`$mydesc <Text>`: Add details.\n" +
                        "`$whoami [Name]`: View character sheet (yours or others).\n" +
                        "`$party`: View all characters.\n" +
                        "`$story <CharName>`: Generate character biography.\n" +
                        "`$clearchara`: Reset your sheet."
                },
                {
                    name: "⚙️ Configuration & Status",
                    value:
                        "`$setcmd`: Set this channel for commands.\n" +
                        "`$setsummary`: Set this channel for summaries.\n" +
                        "`$status`: Show processing queue status.\n" +
                        "`$metrics`: Show live session metrics."
                },
                {
                    name: "🔧 Advanced Commands",
                    value:
                        "**NPC Alias (for RAG)**\n" +
                        "`$npc alias <Name> add <Alias>`: Add alias.\n" +
                        "`$npc alias <Name> remove <Alias>`: Remove alias.\n\n" +
                        "**Timeline**\n" +
                        "`$timeline delete <ID>`: Delete historical event.\n\n" +
                        "**Travels**\n" +
                        "`$travels fixcurrent <R> | <L>`: Fix current position.\n" +
                        "`$travels delete <ID>`: Delete history entry.\n\n" +
                        "**Other**\n" +
                        "`$tones`: List narrative tones for `$narrate`.\n" +
                        "`$autoupdate on/off`: Toggle auto-update PC biographies.\n" +
                        "`$reprocess <ID>`: Regenerate memory/data (no re-transcription)."
                },
                {
                    name: "🧪 Test & Debug",
                    value:
                        "`$teststream <URL>`: Simulate a session via direct audio link.\n" +
                        "`$cleantest`: Remove all test sessions from DB."
                },
                {
                    name: "💡 Command Aliases",
                    value: "Many commands have Italian aliases: `$location`/`$luogo`, `$atlas`/`$atlante`, `$dossier`/`$npc`, `$travels`/`$viaggi`, `$inventory`/`$inventario`, `$bestiary`/`$bestiario`, `$mergeitem`/`$unisciitem`, `$mergequest`/`$unisciquest`, etc."
                }
            )
            .setFooter({ text: "Per la versione italiana usa $aiuto" });

        await ctx.message.reply({ embeds: [helpEmbed] });
    }
};
