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
                    .setDescription(`Common interface for managing campaign entities like NPCs, Quests, Locations, Items, Monsters, and Factions.`)
                    .addFields(
                        { name: "📋 Listing", value: `\`$${arg}\`: See all items (dossier list).\n\`$${arg} list\`: Explicit listing.\n\`$${arg} #ID\`: View details for a specific entity.` },
                        { name: "📝 Narrative Update", value: `\`$${arg} update <ID> | <Note>\`\nAdd a story update or observation. This triggers an AI bio regeneration.` },
                        { name: "⚙️ Metadata Update", value: `\`$${arg} update <ID> field:<key> <val>\`\nDirectly edit fields (e.g., \`field:status DEFEATED\`).` },
                        { name: "🔀 Merge", value: `\`$${arg} merge <OldID/Name> | <NewID/Name>\`\nCombine duplicates into one record.` },
                        { name: "📜 Event History", value: `\`$${arg} events [page]\`: View paginated history of events.` },
                        { name: "🗑️ Delete", value: `\`$${arg} delete <ID>\`\nPermanently remove the entity.` }
                    );
            } else if (arg === 'timeline') {
                embed.setTitle(`⏳ Command: $timeline`)
                    .setDescription(`Manage the historical events of your world.`)
                    .addFields(
                        { name: "📜 Show Timeline", value: `\`$timeline\`: Displays the chronological history.` },
                        { name: "➕ Add Event", value: `\`$timeline add <Year> | <Type> | <Description>\`\nAdd a significant historical milestone.` },
                        { name: "🏷️ Event Types", value: `Valid types: \`WAR\`, \`POLITICS\`, \`DISCOVERY\`, \`CALAMITY\`, \`SUPERNATURAL\`, \`GENERIC\`.` },
                        { name: "🗑️ Delete", value: `\`$timeline delete #ID\`: Remove an event using its Short ID.` }
                    );
            } else if (arg === 'date' || arg === 'year0') {
                embed.setTitle(`📅 Calendar Commands`)
                    .addFields(
                        { name: "$date <Year>", value: `Sets the current campaign year. Affects timeline and recording timestamps.` },
                        { name: "$year0 <Description>", value: `Defines the pivot point of history (Year 0) and resets current year to 0.` }
                    );
            } else if (arg === 'npc') {
                // Special case for npc alias
                embed.setTitle(`👥 NPC Special: $npc alias`)
                    .addFields(
                        { name: "Manage Nicknames", value: `\`$npc alias <ID> add <Nickname>\`: Add a recognized name.\n\`$npc alias <ID> remove <Nickname>\`: Remove a nickname.` }
                    );
            } else if (arg === 'loot' || arg === 'mergeitem') {
                embed.setTitle(`📦 Inventory Special`)
                    .addFields(
                        { name: "$loot use <ID>", value: `Consume an item (decrements count or removes it).` },
                        { name: "$mergeitem <ID1> | <ID2>", value: `Legacy command to merge items (use \`$loot merge\` instead).` }
                    );
            } else if (arg === 'travels' || arg === 'viaggi') {
                embed.setTitle(`🗺️ Travel Log: $travels fix`)
                    .addFields(
                        { name: "Fix Location History", value: `\`$travels fix #ID | <NewRegion> | <NewPlace>\`\nCorrect a mistake in the journey log.` }
                    );
            } else if (arg === 'affiliate') {
                embed.setTitle(`🛡️ Affiliations: $affiliate`)
                    .addFields(
                        { name: "Usage", value: `\`$affiliate <Type> <Name> | <Faction> | <Role>\`` },
                        { name: "Listing", value: `\`$affiliate list <Faction>\`: See members.\n\`$affiliate of <Entity>\`: See entity's factions.` },
                        { name: "Examples", value: `\`$affiliate npc Frodo | Fellowship | MEMBER\`\n\`$affiliate location Rivendell | Elves | CONTROLLED\`` },
                        { name: "Roles", value: `NPC: MEMBER, LEADER, ALLY, ENEMY, PRISONER\nLocation: CONTROLLED, PRESENCE, BASE` }
                    );
            } else if (arg === 'presenze') {
                embed.setTitle(`👥 Session NPCs: $presenze`)
                    .setDescription(`View which NPCs were present or interacted during a specific session.`)
                    .addFields(
                        { name: "Current Session", value: `\`$presenze\`: Shows NPCs from the active session.` },
                        { name: "Specific Session", value: `\`$presenze session_xxxx\`: Shows NPCs from a past session.` }
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
                        "`$selectcampaign <Name>`: Switch active campaign."
                },
                {
                    name: "🧩 Unified Entity Interface",
                    value:
                        "**Entities:** `$npc`, `$quest`, `$atlas`, `$loot`, `$bestiary`, `$faction`\n" +
                        "• `$cmd list` / `$cmd #ID`: Manage records.\n" +
                        "• `$cmd events`: View history.\n" +
                        "• `$cmd update`: Narrative or field updates.\n" +
                        "• `$cmd merge` / `$cmd delete`: Maintenance.\n" +
                        "💡 *Type `$help <entity>` (e.g. `$help npc`) for details.*"
                },
                {
                    name: "👥 Specific Commands",
                    value:
                        "`$npc alias`: Manage nicknames.\n" +
                        "`$loot use`: Consume item.\n" +
                        "`$quest done`: Complete quest.\n" +
                        "`$travels fix`: Fix location history.\n" +
                        "`$timeline add`: Create history.\n" +
                        "`$date` / `$year0`: Manage calendar.\n" +
                        "💡 *Type `$help <command>` for details.*"
                },
                {
                    name: "🔧 Admin & Config",
                    value:
                        "`$setcmd`: Set command channel.\n" +
                        "`$setsession <N>`: Force session number.\n" +
                        "`$autoupdate on/off`: Auto-update bios.\n" +
                        "`$presenze <ID>`: Session NPC list."
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
                        "`$metrics`: Session stats (cost, tokens).\n" +
                        "`$listsessions`: View all recorded sessions."
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
                        "`$location <Region> | <Place>`: Set location manually.\n" +
                        "`$travels`: View campaign travel history."
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
                        "`$bio reset [Name]`: Regenerate PC bio.\n" +
                        "`$presenze`: NPCs encountered this session."
                },
                {
                    name: "🧩 Records & Lists",
                    value:
                        "`$npc`: List known NPCs.\n" +
                        "`$quest`: Show active quests.\n" +
                        "`$loot`: group inventory.\n" +
                        "`$atlas`: View world locations.\n" +
                        "`$bestiary`: Encountered monsters.\n" +
                        "`$faction`: Factions and reputations."
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
