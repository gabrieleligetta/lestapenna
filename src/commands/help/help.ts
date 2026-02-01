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
        const arg = ctx.args[0]?.toLowerCase();
        const isAdvanced = arg === 'advanced';

        if (arg && !['advanced', 'dev'].includes(arg)) {
            // --- DETAILED COMMAND HELP ---
            const embed = new EmbedBuilder().setColor("#D4AF37");

            if (['npc', 'quest', 'atlas', 'loot', 'bestiary', 'faction'].includes(arg)) {
                embed.setTitle(`🧩 Unified Entity: $${arg}`)
                    .setDescription(`Unified interface for managing campaign entities. Most subcommands are **interactive**.`)
                    .addFields(
                        { name: "🔍 Exploration", value: `\`$${arg}\`: Interactive list & search.\n\`$${arg} #ID\`: View detailed dossier.` },
                        { name: "⚡ Interactive Actions", value: `\`$${arg} add\`: Create new.\n\`$${arg} update\`: Modify fields/narrative.\n\`$${arg} merge\`: Combine duplicates.\n\`$${arg} delete\`: Removal flow.` },
                        { name: "📜 Events Management", value: `\`$${arg} events\`: Browse history.\n\`$${arg} events add\`: Manually log a new life event.\n\`$${arg} events update\`: Edit past events.\n\`$${arg} events delete\`: Remove mistakes.\n*Example: \`$${arg} events add Garlon\`*` },
                        { name: "📝 Quick Narrative Update", value: `\`$${arg} update <ID> | <Note>\`\nAdd a story update to trigger AI bio regeneration.` }
                    );
            } else if (arg === 'affiliate') {
                embed.setTitle(`🛡️ Affiliations: $affiliate`)
                    .setDescription("Manage relationships between entities (NPCs/Locations) and Factions.")
                    .addFields(
                        { name: "🔍 Viewing", value: `\`$affiliate list <Faction>\`: List all members.\n\`$affiliate of <Entity>\`: See which factions a character/place belongs to.` },
                        { name: "🤝 Managing (Interactive)", value: `\`$affiliate\`: Start the interactive association flow.` },
                        { name: "📝 Manual Usage", value: `\`$affiliate <Type> <Name> | <Faction> | <Role>\`\ne.g., \`$affiliate npc Frodo | Fellowship | MEMBER\`` }
                    );
            } else if (arg === 'timeline') {
                embed.setTitle(`⏳ Command: $timeline`)
                    .setDescription(`Manage the historical events of your world.`)
                    .addFields(
                        { name: "📜 Show Timeline", value: `\`$timeline\`: Displays the chronological history.` },
                        { name: "➕ Add Event", value: `\`$timeline add <Year> | <Type> | <Description>\`\nAdd a significant historical milestone.` },
                        { name: "🗑️ Delete", value: `\`$timeline delete #ID\`: Remove an event using its Short ID.` }
                    );
            } else if (arg === 'campaign' || arg === 'campagna' || arg === 'campaigns') {
                embed.setTitle(`🗺️ Campaign Management`)
                    .setDescription("Manage your tabletop RPG campaigns.")
                    .addFields(
                        { name: "📜 Listing", value: "`$listcampaigns`: See all your campaigns." },
                        { name: "➕ Creation", value: "`$createcampaign <Name>`: Start a new campaign." },
                        { name: "🔌 Switch", value: "`$selectcampaign <Name/ID>`: Set the active campaign for this server." },
                        { name: "🗑️ Deletion", value: "`$deletecampaign <Name/ID>`: Permanently remove a campaign." }
                    );
            } else if (arg === 'setworld') {
                embed.setTitle(`🌍 Command: $setworld`)
                    .setDescription("The primary way to configure your campaign's setting.")
                    .addFields(
                        { name: "⚙️ Interactive Setup", value: "Type `$setworld` to open the configuration menu. You can set:\n• Current Year\n• Current Location (Region & Place)\n• Party Faction Name" }
                    );
            } else {
                await ctx.message.reply(`❌ Detailed help for \`$${arg}\` not found. Use \`$help\` or \`$help advanced\`.`);
                return;
            }

            await ctx.message.reply({ embeds: [embed] });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor("#D4AF37")
            .setFooter({ text: "🇮🇹 Per la versione italiana: $aiuto" })
            .setTitle(isAdvanced ? "🔧 Lestapenna - Advanced Tools" : "🖋️ Lestapenna - Quick Start")
            .setDescription(isAdvanced
                ? "Management and administration tools for DMs."
                : "Welcome to Lestapenna! Here are the essential commands to get started.");

        if (isAdvanced) {
            // --- ADVANCED VIEW ---
            embed.addFields(
                {
                    name: "🗺️ Campaign Management",
                    value:
                        "`$listcampaigns`: List all campaigns.\n" +
                        "`$createcampaign <Name>`: Create new campaign.\n" +
                        "`$selectcampaign <Name>`: Switch active campaign."
                },
                {
                    name: "🧩 Maintenance & Admin",
                    value:
                        "`$setcmd`: Set command channel.\n" +
                        "`$autoupdate on/off`: Toggle automatic bio updates.\n" +
                        "`$sync all`: Force RAG synchronization for all NPCs.\n" +
                        "`$metrics`: View AI usage and costs."
                },
                {
                    name: "🛠️ Specialized Commands",
                    value:
                        "`$timeline add`: Create manual history events.\n" +
                        "`$date <Year>`: Set current calendar year.\n" +
                        "`$year0 <Desc>`: Define the pivot point of history.\n" +
                        "💡 *Type `$help <command>` (e.g. `$help affiliate`) for details.*"
                }
            );
        } else if (ctx.args[0]?.toLowerCase() === 'dev') {
            // --- DEVELOPER VIEW ---
            embed.setTitle("👨‍💻 Developer Tools")
                .addFields(
                    {
                        name: "🧪 Debug",
                        value: "`$status`: Queue health.\n`$debug teststream <URL>`: Simulation.\n`$rebuild CONFIRM`: Re-index DB."
                    },
                    {
                        name: "⚠️ Danger Zone",
                        value: "`$wipe softwipe`: Clear RAG.\n`$wipe wipe`: NUKE DB.\n`$clearchara`: Reset your PC."
                    }
                );
        } else {
            // --- BASIC VIEW ---
            embed.addFields(
                {
                    name: "🚀 Getting Started",
                    value:
                        "• `$listcampaigns`: View your campaigns.\n" +
                        "• `$createcampaign <Name>`: Start a new one.\n" +
                        "• `$selectcampaign <Name>`: Set the active one."
                },
                {
                    name: "🎙️ Sessions",
                    value:
                        "• `$listen`: Start recording (interactive setup).\n" +
                        "• `$stop`: End session & generate summary.\n" +
                        "• `$listsessions`: Browse archives & download transcripts."
                },
                {
                    name: "🌍 World Tracking",
                    value:
                        "• `$setworld`: **Config menu** (Year, Location, Party).\n" +
                        "• `$location`: Where are you right now?\n" +
                        "• `$timeline`: Browse the world's history."
                },
                {
                    name: "👤 Characters & Party",
                    value:
                        "• `$iam <Name>`: Link yourself to a character.\n" +
                        "• `$whoami`: View your sheet.\n" +
                        "• `$party`: View your companions."
                },
                {
                    name: "🧩 Unified Records (Interactive)",
                    value:
                        "Manage your world's entities with these commands:\n" +
                        "**`$npc`, `$quest`, `$loot`, `$atlas`, `$faction`, `$bestiary`**\n" +
                        "• Subcommands: `add`, `update`, `delete`, `merge`, `events`"
                },
                {
                    name: "🛡️ Faction Links",
                    value: "• `$affiliate`: Manage who belongs where."
                },
                {
                    name: "📖 Narrative",
                    value:
                        "• `$ask <Topic>`: Ask the Bard about the lore.\n" +
                        "• `$wiki <Term>`: Search the archives."
                },
                {
                    name: "🔧 More",
                    value: "For DM tools and campaign management, type **`$help advanced`**."
                }
            );
        }

        await ctx.message.reply({ embeds: [embed] });
    }
};
