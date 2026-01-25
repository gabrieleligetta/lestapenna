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
        const isAdvanced = ctx.args[0]?.toLowerCase() === 'advanced';

        const embed = new EmbedBuilder()
            .setColor("#D4AF37")
            .setFooter({ text: "🇮🇹 Per la versione italiana: $aiuto" })
            .setTitle(isAdvanced ? "🔧 Lestapenna - Advanced Commands" : "🖋️ Lestapenna - Basic Commands")
            .setDescription(isAdvanced
                ? "Power tools for Dungeon Masters and Admins.\nFor basic usage, type `$help`."
                : "Essential commands for players and quick reference.\nFor editing and admin tools, type `$help advanced`.");

        if (isAdvanced) {
            // --- ADVANCED VIEW ---
            embed.addFields(
                {
                    name: "🗺️ Campaigns",
                    value:
                        "`$listcampaigns`: List all campaigns.\n" +
                        "`$createcampaign <Name>`: Create new campaign.\n" +
                        "`$selectcampaign <Name>`: Switch active campaign.\n" +
                        "`$deletecampaign <Name>`: Delete a campaign."
                },
                {
                    name: "🧩 Unified Entity Interface",
                    value:
                        "**Entities:** `$npc`, `$quest`, `$atlas`, `$loot`, `$bestiary`\n" +
                        "**Syntaxes:**\n" +
                        "• `$cmd list` / `$cmd #ID`\n" +
                        "• `$cmd update <ID> | <Note>` (Narrative)\n" +
                        "• `$cmd update <ID> field:<key> <val>` (Metadata)\n" +
                        "• `$cmd merge <Old> | <New>`\n" +
                        "• `$cmd delete <ID>`"
                },
                {
                    name: "👥 Specific Commands",
                    value:
                        "`$npc alias`: Manage nicknames.\n" +
                        "`$loot use`: Consume item.\n" +
                        "`$mergeitem`: Merge duplicate items.\n" +
                        "`$quest done`: Complete quest.\n" +
                        "`$travels fix`: Fix location history.\n" +
                        "`$timeline add <Year> | <Type> | <Desc>`\n" +
                        "`$date <Year>` / `$year0 <Desc>`"
                },
                {
                    name: "🔧 Admin & Config",
                    value:
                        "`$setcmd`: Set command channel.\n" +
                        "`$setsession <N>`: Force session number.\n" +
                        "`$autoupdate on/off`: Auto-update bios.\n" +
                        "`$download <ID>`: Download master audio.\n" +
                        "`$ingest <ID>`: Manual import.\n" +
                        "`$presenze <ID>`: Session NPC list."
                },
                {
                    name: "⚠️ Danger Zone",
                    value:
                        "`$recover <ID>`: Retry stuck session.\n" +
                        "`$reprocess <ID>`: Regen data (No transcribe).\n" +
                        "`$reset <ID>`: Full Reset (From Audio).\n" +
                        "`$recover regenerate-all`: **Time Travel** (Full Regen).\n" +
                        "`$wipe`: Reset data."
                }
            );
        } else if (ctx.args[0]?.toLowerCase() === 'dev') {
            // --- DEVELOPER VIEW ---
            embed.setTitle("👨‍💻 Developer Tools")
                .setDescription("Debug and maintenance tools. Use with caution.")
                .addFields(
                    {
                        name: "🧪 Debug & Test",
                        value:
                            "`$debug teststream <URL>`: Simulate session from audio link.\n" +
                            "`$debug testmail`: Send test email report.\n" +
                            "`$rebuild CONFIRM`: Re-index full database (DEV ONLY).\n" +
                            "`$status`: Show internal queue health."
                    },
                    {
                        name: "🛠️ Low Level",
                        value:
                            "`$wipe softwipe`: Clear RAG/derived data.\n" +
                            "`$wipe wipe`: NUKE DATABASE.\n" +
                            "`$clearchara`: Delete your PC."
                    }
                );
        } else {
            // --- BASIC VIEW ---
            embed.addFields(
                {
                    name: "ℹ️ General",
                    value:
                        "`$help`: Show this list.\n" +
                        "`$status`: System health & queues.\n" +
                        "`$metrics`: Session stats (cost, tokens)."
                },
                {
                    name: "🎙️ Session",
                    value:
                        "`$listen [Location]`: Start recording.\n" +
                        "`$stop`: End session & transcribe.\n" +
                        "`$listsessions`: List stored sessions.\n" +
                        "`$pause` / `$resume`: Control recording.\n" +
                        "`$note <Text>`: Add manual note."
                },
                {
                    name: "🌍 Location",
                    value:
                        "`$location`: Show current location.\n" +
                        "`$location <Region> | <Place>`: Set location manually."
                },
                {
                    name: "📜 Narrative",
                    value:
                        "`$ask <Question>`: Ask the Bard (Lore).\n" +
                        "`$wiki <Term>`: Search archives.\n" +
                        "`$narrate <ID> [tone]`: Regenerate summary.\n" +
                        "`$timeline`: Show history."
                },
                {
                    name: "👤 Character",
                    value:
                        "`$iam <Name>`: Link your user.\n" +
                        "`$whoami`: View your sheet.\n" +
                        "`$party`: View party members.\n" +
                        "`$myclass <Class>` / `$myrace <Race>`: Set sheet info.\n" +
                        "`$story <Name>`: Read PC history.\n" +
                        "`$mydesc <Text>`: Set manual bio.\n" +
                        "`$bio reset [Name]`: Regenerate PC bio."
                },
                {
                    name: "🔧 Advanced Tools",
                    value: "Need to manage entities, inventory, or admin tools?\n👉 **Type `$help advanced`**"
                }
            );
        }

        await ctx.message.reply({ embeds: [embed] });
    }
};
