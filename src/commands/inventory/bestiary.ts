/**
 * $bestiario / $bestiary command - Monster bestiary
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    listAllMonsters,
    mergeMonsters,
    addBestiaryEvent,
    getMonsterByName,
    getBestiaryHistory,
    getMonsterByShortId,
    deleteMonster
} from '../../db';
import { guildSessions } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';
import { showEntityEvents } from '../utils/eventsViewer';

// Helper for Regen
async function regenerateMonsterBio(campaignId: number, monsterName: string) {
    const history = getBestiaryHistory(campaignId, monsterName);
    const monster = getMonsterByName(campaignId, monsterName);
    const currentDesc = monster?.description || "";

    // Map history to simple objects
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('MONSTER', { campaignId, name: monsterName, currentDesc }, simpleHistory);
}

export const bestiaryCommand: Command = {
    name: 'bestiary',
    aliases: ['bestiario', 'mostri', 'monsters'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');

        const generateMonsterDetailEmbed = (monster: any) => {
            const formatCount = (c: string) => {
                const n = Number(c);
                return !isNaN(n) ? n.toString() : c;
            };

            const statusColor = monster.status === 'ALIVE' ? "#00FF00" :
                monster.status === 'DEFEATED' ? "#FF0000" :
                    monster.status === 'FLED' ? "#FFFF00" : "#7289DA";

            const statusIcon = monster.status === 'ALIVE' ? '⚔️' :
                monster.status === 'DEFEATED' ? '💀' :
                    monster.status === 'FLED' ? '🏃' : '👹';

            const embed = new EmbedBuilder()
                .setTitle(`${statusIcon} ${monster.name}`)
                .setColor(statusColor)
                .setDescription(monster.description || "*Nessuna descrizione.*")
                .addFields(
                    { name: "Stato", value: monster.status, inline: true },
                    { name: "ID", value: `\`#${monster.short_id}\``, inline: true }
                );

            if (monster.count) embed.addFields({ name: "Numero", value: formatCount(monster.count), inline: true });

            const abilities = monster.abilities ? JSON.parse(monster.abilities) : [];
            const weaknesses = monster.weaknesses ? JSON.parse(monster.weaknesses) : [];
            const resistances = monster.resistances ? JSON.parse(monster.resistances) : [];

            if (abilities.length > 0) embed.addFields({ name: "⚔️ Abilità", value: abilities.join(', ') });
            if (weaknesses.length > 0) embed.addFields({ name: "🎯 Debolezze", value: weaknesses.join(', ') });
            if (resistances.length > 0) embed.addFields({ name: "🛡️ Resistenze", value: resistances.join(', ') });
            if (monster.notes) embed.addFields({ name: "📝 Note", value: monster.notes });

            embed.setFooter({ text: `Usa $bestiario update ${monster.short_id} | <Nota> per aggiornare.` });
            return embed;
        };

        // SUBCOMMAND: $bestiario update <Name> | <Note>
        if (arg.toLowerCase().startsWith('update ')) {
            const content = arg.substring(7);
            const parts = content.split('|');
            if (parts.length < 2) {
                await ctx.message.reply("⚠️ Uso: `$bestiario update <Mostro/ID> | <Nota/Osservazione>`");
                return;
            }
            let name = parts[0].trim();
            const note = parts.slice(1).join('|').trim();

            // ID Resolution
            const sidMatch = name.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const monster = getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (monster) name = monster.name;
            }

            const monster = getMonsterByName(ctx.activeCampaign!.id, name);
            if (!monster) {
                await ctx.message.reply(`❌ Mostro "${name}" non trovato.`);
                return;
            }

            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addBestiaryEvent(ctx.activeCampaign!.id, name, currentSession, note, "MANUAL_UPDATE", true);
            await ctx.message.reply(`📝 Nota aggiunta a **${name}**. Aggiornamento dossier...`);

            await regenerateMonsterBio(ctx.activeCampaign!.id, name);
            return;
        }

        // SUBCOMMAND: $bestiario delete <Name>
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            let name = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const sidMatch = name.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const monster = getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (monster) name = monster.name;
            }

            const existing = getMonsterByName(ctx.activeCampaign!.id, name);
            if (!existing) {
                await ctx.message.reply(`❌ Mostro "${name}" non trovato.`);
                return;
            }

            // Delete
            const success = deleteMonster(ctx.activeCampaign!.id, name);
            if (success) {
                await ctx.message.reply(`🗑️ Mostro **${name}** eliminato dal bestiario.`);
            } else {
                await ctx.message.reply(`❌ Impossibile eliminare **${name}**.`);
            }
            return;
        }

        // SUBCOMMAND: $bestiario merge <old> | <new>
        if (arg.toLowerCase().startsWith('merge ')) {
            const parts = arg.substring(6).split('|').map(s => s.trim());
            if (parts.length !== 2) {
                await ctx.message.reply("Uso: `$bestiario merge <nome vecchio/ID> | <nome nuovo/ID>`");
                return;
            }
            let [oldName, newName] = parts;

            // Resolve Old Name
            const oldSidMatch = oldName.match(/^#([a-z0-9]{5})$/i);
            if (oldSidMatch) {
                const m = getMonsterByShortId(ctx.activeCampaign!.id, oldSidMatch[1]);
                if (m) oldName = m.name;
            }

            // Resolve New Name
            const newSidMatch = newName.match(/^#([a-z0-9]{5})$/i);
            if (newSidMatch) {
                const m = getMonsterByShortId(ctx.activeCampaign!.id, newSidMatch[1]);
                if (m) newName = m.name;
            }

            const success = mergeMonsters(ctx.activeCampaign!.id, oldName, newName);
            if (success) {
                await ctx.message.reply(`✅ **Mostro unito!**\n👹 **${oldName}** è stato integrato in **${newName}**`);
            } else {
                await ctx.message.reply(`❌ Impossibile unire. Verifica che "${oldName}" esista nel bestiario.`);
            }
            return;
        }

        // SUBCOMMAND: events - $bestiario <name/#id> events [page]
        const eventsMatch = arg.match(/^(.+?)\s+events(?:\s+(\d+))?$/i);
        if (eventsMatch) {
            let monsterIdentifier = eventsMatch[1].trim();
            const page = eventsMatch[2] ? parseInt(eventsMatch[2]) : 1;

            // Resolve short ID
            const sidMatch = monsterIdentifier.match(/^#([a-z0-9]{5})$/i);
            if (sidMatch) {
                const m = getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (m) monsterIdentifier = m.name;
                else {
                    await ctx.message.reply(`❌ Mostro con ID \`#${sidMatch[1]}\` non trovato.`);
                    return;
                }
            }

            // Verify monster exists
            const monster = getMonsterByName(ctx.activeCampaign!.id, monsterIdentifier);
            if (!monster) {
                await ctx.message.reply(`❌ Mostro **${monsterIdentifier}** non trovato.`);
                return;
            }

            await showEntityEvents(ctx, {
                tableName: 'bestiary_history',
                entityKeyColumn: 'monster_name',
                entityKeyValue: monster.name,
                campaignId: ctx.activeCampaign!.id,
                entityDisplayName: monster.name,
                entityEmoji: '👹'
            }, page);
            return;
        }

        // VIEW: Show specific monster details (ID or Name)
        if (!arg || arg.toLowerCase().startsWith('list') || arg.toLowerCase().startsWith('lista')) {
            // Proceed to list below
        } else if (!arg.includes('|')) {
            let search = arg;

            // ID Resolution
            const sidMatch = search.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const monster = getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (monster) search = monster.name;
            }

            const monster = listAllMonsters(ctx.activeCampaign!.id).find((m: any) =>
                m.name.toLowerCase().includes(search.toLowerCase())
            );
            if (!monster) {
                await ctx.message.reply(`❌ Mostro "${arg}" non trovato nel bestiario.`);
                return;
            }

            await ctx.message.reply({ embeds: [generateMonsterDetailEmbed(monster)] });
            return;
        }

        // VIEW: List all monsters (Paginated)
        let initialPage = 1;
        if (arg) {
            const listParts = arg.split(' ');
            if (listParts.length > 1 && !isNaN(parseInt(listParts[1]))) {
                initialPage = parseInt(listParts[1]);
            }
        }
        const monsters = listAllMonsters(ctx.activeCampaign!.id);
        if (monsters.length === 0) {
            await ctx.message.reply("👹 Nessun mostro incontrato in questa campagna.");
            return;
        }

        // Sort: ALIVE first, then FLED, then DEFEATED
        const statusOrder: Record<string, number> = { 'ALIVE': 0, 'FLED': 1, 'DEFEATED': 2 };
        monsters.sort((a: any, b: any) => {
            const sA = statusOrder[a.status] ?? 99;
            const sB = statusOrder[b.status] ?? 99;
            return sA - sB;
        });

        const ITEMS_PER_PAGE = 5;
        let currentPage = Math.max(0, initialPage - 1);

        const generateEmbed = (page: number) => {
            const offset = page * ITEMS_PER_PAGE;
            const currentItems = monsters.slice(offset, offset + ITEMS_PER_PAGE);
            const totalPages = Math.ceil(monsters.length / ITEMS_PER_PAGE);

            const list = currentItems.map((m: any) => {
                const statusIcon = m.status === 'ALIVE' ? '⚔️' :
                    m.status === 'DEFEATED' ? '💀' :
                        m.status === 'FLED' ? '🏃' : '👹';

                const countStr = m.count ? ` (x${m.count})` : '';
                const desc = m.description ? `\n> *${m.description.substring(0, 80)}${m.description.length > 80 ? '...' : ''}*` : '';

                return `\`#${m.short_id}\` ${statusIcon} **${m.name}**${countStr} [${m.status}]${desc}`;
            }).join('\n\n');

            const embed = new EmbedBuilder()
                .setTitle(`👹 Bestiario (${ctx.activeCampaign?.name})`)
                .setColor("#7289DA")
                .setDescription(list)
                .setFooter({ text: `Pagina ${page + 1} di ${totalPages} • Totale: ${monsters.length}` });

            return { embed, totalPages };
        };

        const generateButtons = (page: number, totalPages: number) => {
            const row = new ActionRowBuilder<ButtonBuilder>();
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('prev_page')
                    .setLabel('⬅️ Precedente')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === 0),
                new ButtonBuilder()
                    .setCustomId('next_page')
                    .setLabel('Successivo ➡️')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(page === totalPages - 1)
            );
            return row;
        };

        const generateSelectMenu = (monsters: any[]) => {
            if (monsters.length === 0) return null;

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_monster')
                .setPlaceholder('🔍 Seleziona un mostro per i dettagli...')
                .addOptions(
                    monsters.map((m: any) => {
                        const statusIcon = m.status === 'ALIVE' ? '⚔️' :
                            m.status === 'DEFEATED' ? '💀' :
                                m.status === 'FLED' ? '🏃' : '👹';

                        return new StringSelectMenuOptionBuilder()
                            .setLabel(m.name.substring(0, 100))
                            .setDescription(`ID: #${m.short_id} | ${m.status}`)
                            .setValue(m.name)
                            .setEmoji(statusIcon);
                    })
                );

            return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        };

        const initialData = generateEmbed(currentPage);
        const offset = currentPage * ITEMS_PER_PAGE;
        const currentMonsters = monsters.slice(offset, offset + ITEMS_PER_PAGE);

        const components: any[] = [];
        if (initialData.totalPages > 1) components.push(generateButtons(currentPage, initialData.totalPages));
        const selectRow = generateSelectMenu(currentMonsters);
        if (selectRow) components.push(selectRow);

        const reply = await ctx.message.reply({
            embeds: [initialData.embed],
            components
        });

        if (initialData.totalPages > 1 || monsters.length > 0) {
            const collector = reply.createMessageComponentCollector({
                time: 60000 * 5 // 5 minutes
            });

            collector.on('collect', async (interaction: MessageComponentInteraction) => {
                if (interaction.user.id !== ctx.message.author.id) {
                    await interaction.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
                    return;
                }

                if (interaction.isButton()) {
                    if (interaction.customId === 'prev_page') {
                        currentPage = Math.max(0, currentPage - 1);
                    } else if (interaction.customId === 'next_page') {
                        currentPage++;
                    }

                    const newData = generateEmbed(currentPage);
                    const newOffset = currentPage * ITEMS_PER_PAGE;
                    const newMonsters = monsters.slice(newOffset, newOffset + ITEMS_PER_PAGE);

                    const newComponents: any[] = [];
                    if (newData.totalPages > 1) newComponents.push(generateButtons(currentPage, newData.totalPages));
                    const newSelectRow = generateSelectMenu(newMonsters);
                    if (newSelectRow) newComponents.push(newSelectRow);

                    await interaction.update({
                        embeds: [newData.embed],
                        components: newComponents
                    });
                } else if (interaction.isStringSelectMenu()) {
                    if (interaction.customId === 'select_monster') {
                        const selectedName = interaction.values[0];
                        const monster = monsters.find((m: any) => m.name === selectedName);
                        if (monster) {
                            const detailEmbed = generateMonsterDetailEmbed(monster);
                            await interaction.reply({ embeds: [detailEmbed] });
                        } else {
                            await interaction.reply({ content: "Mostro non trovato.", ephemeral: true });
                        }
                    }
                }
            });

            collector.on('end', () => {
                reply.edit({ components: [] }).catch(() => { });
            });
        }
    }
};
