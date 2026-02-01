/**
 * $bestiario / $bestiary command - Monster bestiary
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    bestiaryRepository,
    db
} from '../../db';
import { guildSessions } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';
import { showEntityEvents } from '../utils/eventsViewer';
import {
    startInteractiveBestiaryUpdate,
    startInteractiveBestiaryDelete
} from './bestiaryInteractive';

// Helper for Regen - usato SOLO per note narrative
async function regenerateMonsterBio(campaignId: number, monsterName: string) {
    const history = bestiaryRepository.getBestiaryHistory(campaignId, monsterName);
    const monster = bestiaryRepository.getMonsterByName(campaignId, monsterName);
    const currentDesc = monster?.description || "";

    const simpleHistory = history.map((h: any) => ({ description: h.description, event_type: h.event_type }));
    await generateBio('MONSTER', { campaignId, name: monsterName, currentDesc }, simpleHistory);
}

// Helper per marcare dirty (rigenerazione asincrona in background)
function markBestiaryDirtyForSync(campaignId: number, name: string) {
    bestiaryRepository.markBestiaryDirty(campaignId, name);
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

        // SUBCOMMAND: $bestiario update <Name or ID> [| <Note> OR <field> <value>]
        if (arg.toLowerCase() === 'update' || arg.toLowerCase().startsWith('update ')) {
            const fullContent = arg.substring(7).trim(); // Remove 'update '

            if (!fullContent) {
                await startInteractiveBestiaryUpdate(ctx);
                return;
            }

            // 1. Identify Target (ID or Name)
            let targetIdentifier = "";
            let remainingArgs = "";
            // ... rest of existing logic ...
            if (fullContent.startsWith('#')) {
                const parts = fullContent.split(' ');
                targetIdentifier = parts[0];
                remainingArgs = parts.slice(1).join(' ');
            } else {
                if (fullContent.includes('|')) {
                    targetIdentifier = fullContent.split('|')[0].trim();
                    remainingArgs = "|" + fullContent.split('|').slice(1).join('|');
                } else {
                    const keywords = ['status', 'stato', 'count', 'numero'];
                    const lower = fullContent.toLowerCase();
                    let splitIndex = -1;

                    for (const kw of keywords) {
                        const searchStr = ` ${kw} `;
                        const idx = lower.lastIndexOf(searchStr);
                        if (idx !== -1) {
                            splitIndex = idx;
                            break;
                        }
                    }

                    if (splitIndex !== -1) {
                        targetIdentifier = fullContent.substring(0, splitIndex).trim();
                        remainingArgs = fullContent.substring(splitIndex + 1).trim();
                    } else {
                        targetIdentifier = fullContent;
                        remainingArgs = "";
                    }
                }
            }

            // Resolve Monster
            let monster: any;
            const sidMatch = targetIdentifier.match(/^#?([a-z0-9]{5})$/i);

            if (sidMatch) {
                const m = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (m) monster = m;
            }
            if (!monster) {
                monster = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, targetIdentifier);
            }

            if (!monster) {
                await ctx.message.reply(`❌ Mostro "${targetIdentifier}" non trovato.`);
                return;
            }

            if (!remainingArgs) {
                await startInteractiveBestiaryUpdate({ ...ctx, args: [targetIdentifier] });
                return;
            }

            // 2. Parse Actions
            // ... rest of logic ...
            if (remainingArgs.trim().startsWith('|')) {
                const note = remainingArgs.replace('|', '').trim();
                const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
                bestiaryRepository.addBestiaryEvent(ctx.activeCampaign!.id, monster.name, currentSession, note, "MANUAL_UPDATE", true);

                await ctx.message.reply(`📝 Nota aggiunta a **${monster.name}**. Aggiornamento dossier...`);
                await regenerateMonsterBio(ctx.activeCampaign!.id, monster.name);
                return;
            }

            // Case B: Metadata Update
            const args = remainingArgs.trim().split(/\s+/);
            const field = args[0]?.toLowerCase();
            const value = args.slice(1).join(' ').toUpperCase();

            const showUpdateHelp = async (errorMsg?: string) => {
                const statusIcon = monster.status === 'ALIVE' ? '⚔️' :
                    monster.status === 'DEFEATED' ? '💀' :
                        monster.status === 'FLED' ? '🏃' : '👹';

                const embed = new EmbedBuilder()
                    .setTitle(`ℹ️ Aggiornamento Bestiario: #${monster.short_id} "${monster.name}"`)
                    .setColor("#3498DB")
                    .setDescription(errorMsg ? `⚠️ **${errorMsg}**\n\n` : "")
                    .addFields(
                        {
                            name: "Valori Attuali",
                            value: `**Status:** ${statusIcon} ${monster.status}\n**Count:** ${monster.count || 'N/A'}`,
                            inline: false
                        },
                        {
                            name: "Campi Modificabili",
                            value: `
• **status**: ALIVE (vivo), DEFEATED (sconfitto/morto), FLED (fuggito)
  *Es: $bestiario update #${monster.short_id} status DEFEATED*
• **count**: Testo libero (es. "3", "un branco")
  *Es: $bestiario update #${monster.short_id} count "un esercito"*
• **Note Narrative** (usa | )
  *Es: $bestiario update #${monster.short_id} | Avvistato vicino al fiume*`
                        }
                    );
                await ctx.message.reply({ embeds: [embed] });
            };

            if (!field || !args[1]) {
                await showUpdateHelp();
                return;
            }

            // 3. Apply Metadata Update
            if (field === 'status' || field === 'stato') {
                const map: Record<string, string> = {
                    'ALIVE': 'ALIVE', 'VIVO': 'ALIVE', 'ACTIVE': 'ALIVE',
                    'DEFEATED': 'DEFEATED', 'SCONFITTO': 'DEFEATED', 'MORTO': 'DEFEATED', 'DEAD': 'DEFEATED', 'UCCISO': 'DEFEATED',
                    'FLED': 'FLED', 'FUGGITO': 'FLED', 'SCAPPATO': 'FLED'
                };

                const mapped = map[value] || map[value.replace(' ', '_')];

                if (!mapped) {
                    await showUpdateHelp(`Valore non valido per '${field}': "${value}"`);
                    return;
                }

                bestiaryRepository.updateBestiaryFields(ctx.activeCampaign!.id, monster.name, { status: mapped }, true);
                // NON aggiungiamo eventi per cambio stato - marca dirty per sync background
                markBestiaryDirtyForSync(ctx.activeCampaign!.id, monster.name);

                await ctx.message.reply(`✅ Stato aggiornato: **${monster.name}** → **${mapped}**`);
                return;
            }

            if (field === 'count' || field === 'numero' || field === 'qt') {
                const rawValue = remainingArgs.trim().split(/\s+/).slice(1).join(' ');
                bestiaryRepository.updateBestiaryFields(ctx.activeCampaign!.id, monster.name, { count: rawValue }, true);
                await ctx.message.reply(`✅ Numero aggiornato: **${monster.name}** → **${rawValue}**`);
                return;
            }

            await showUpdateHelp(`Campo non riconosciuto: "${field}"`);
            return;
        }

        // SUBCOMMAND: $bestiario delete <Name>
        if (arg.toLowerCase() === 'delete' || arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            let name = arg.split(' ').slice(1).join(' ').trim();

            if (!name) {
                await startInteractiveBestiaryDelete(ctx);
                return;
            }

            // ID Resolution
            const sidMatch = name.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const monster = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (monster) name = monster.name;
            }

            const existing = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, name);
            if (!existing) {
                await ctx.message.reply(`❌ Mostro "${name}" non trovato.`);
                return;
            }

            // Delete
            const success = bestiaryRepository.deleteMonster(ctx.activeCampaign!.id, name);
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

            // ID Resolution
            const oldSidMatch = oldName.match(/^#([a-z0-9]{5})$/i);
            if (oldSidMatch) {
                const m = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, oldSidMatch[1]);
                if (m) oldName = m.name;
            }

            // Resolve New Name
            const newSidMatch = newName.match(/^#([a-z0-9]{5})$/i);
            if (newSidMatch) {
                const m = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, newSidMatch[1]);
                if (m) newName = m.name;
            }

            const success = bestiaryRepository.mergeMonsters(ctx.activeCampaign!.id, oldName, newName);
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
                const m = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (m) monsterIdentifier = m.name;
                else {
                    await ctx.message.reply(`❌ Mostro con ID \`#${sidMatch[1]}\` non trovato.`);
                    return;
                }
            }

            // Verify monster exists
            const monster = bestiaryRepository.getMonsterByName(ctx.activeCampaign!.id, monsterIdentifier);
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
                const monster = bestiaryRepository.getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (monster) search = monster.name;
            }

            const monster = bestiaryRepository.listAllMonsters(ctx.activeCampaign!.id).find((m: any) =>
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
        const monsters = bestiaryRepository.listAllMonsters(ctx.activeCampaign!.id);
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
