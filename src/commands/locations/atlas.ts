/**
 * $atlante / $atlas command - Location atlas management
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    getCampaignLocation,
    getAtlasEntry,
    getAtlasEntryFull,
    listAtlasEntries,
    listAllAtlasEntries,
    countAtlasEntries,
    updateAtlasEntry,
    deleteAtlasEntry,
    renameAtlasEntry,
    mergeAtlasEntry,
    markAtlasDirty,
    getDirtyAtlasEntries,
    getSessionTravelLog,
    addAtlasEvent,
    deleteAtlasHistory,
    deleteAtlasRagSummary,
    getAtlasEntryByShortId,
    factionRepository
} from '../../db';
import {
    smartMergeBios,
    syncAllDirtyAtlas,
    syncAtlasEntryIfNeeded
} from '../../bard';
import { startInteractiveAtlasUpdate, startInteractiveAtlasAdd, startInteractiveAtlasDelete } from './interactiveUpdate';
import { startInteractiveMerge, MergeConfig } from '../utils/mergeInteractive';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { showEntityEvents } from '../utils/eventsViewer';

export const atlasCommand: Command = {
    name: 'atlas',
    aliases: ['atlante', 'memoria'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const firstArg = ctx.args[0]?.toLowerCase();
        const argsStr = ctx.args.join(' ');

        if (firstArg === 'delete') {
            await startInteractiveAtlasDelete(ctx);
            return;
        }

        // SUBCOMMAND: $atlante merge [Source] | [Target]
        if (firstArg === 'merge' || firstArg === 'unisci') {
            const content = argsStr.substring(firstArg.length).trim();

            const mergeConfig: MergeConfig = {
                entityType: 'Luogo',
                emoji: '📍',
                campaignId: ctx.activeCampaign!.id,
                listEntities: (cid) => listAllAtlasEntries(cid).map(e => ({
                    id: e.id,
                    shortId: e.short_id || '?????',
                    name: `${e.macro_location} | ${e.micro_location}`,
                    description: e.description || '',
                    metadata: ''
                })),
                resolveEntity: (cid, query) => {
                    const sidMatch = query.match(/^#([a-z0-9]{5})$/i);
                    let entry = null;
                    if (sidMatch) {
                        entry = getAtlasEntryByShortId(cid, sidMatch[1]);
                    } else if (query.includes('|')) {
                        const [macro, micro] = query.split('|').map(s => s.trim());
                        entry = getAtlasEntryFull(cid, macro, micro);
                    } else {
                        // Try simple name search
                        const all = listAllAtlasEntries(cid);
                        entry = all.find(e =>
                            e.micro_location?.toLowerCase() === query.toLowerCase() ||
                            e.macro_location?.toLowerCase() === query.toLowerCase()
                        );
                    }
                    if (!entry) return null;
                    return {
                        id: entry.id,
                        shortId: entry.short_id || '?????',
                        name: `${entry.macro_location} | ${entry.micro_location}`,
                        description: entry.description || '',
                        metadata: ''
                    };
                },
                executeMerge: async (cid, source, target, mergedDesc) => {
                    const s = getAtlasEntryFull(cid, ...source.name.split('|').map(x => x.trim()) as [string, string]);
                    const t = getAtlasEntryByShortId(cid, target.shortId);

                    if (!s || !t) return false;
                    return mergeAtlasEntry(cid, s.macro_location, s.micro_location, t.macro_location, t.micro_location, mergedDesc || t.description || s.description || '');
                }
            };

            await startInteractiveMerge(ctx, mergeConfig, content);
            return;
        }

        // 🆕 Events Subcommand: $atlante events [action] [Target]
        if (firstArg === 'events' || firstArg === 'eventi') {
            const remainder = ctx.args.slice(1);
            const action = remainder[0]?.toLowerCase();
            const campaignId = ctx.activeCampaign!.id;

            // Handlers for Add/Update/Delete
            if (['add', 'update', 'delete', 'modifica', 'rimuovi', 'crea'].includes(action)) {
                // Determine Mode
                let mode: 'ADD' | 'UPDATE' | 'DELETE' = 'ADD';
                if (['update', 'modifica'].includes(action)) mode = 'UPDATE';
                if (['delete', 'rimuovi'].includes(action)) mode = 'DELETE';

                let targetIdentifier = remainder.slice(1).join(' ').trim();

                if (!targetIdentifier) {
                    await ctx.message.reply(`❌ Specifica un luogo: \`$atlante events ${action} <Regione> | <Luogo>\` o \`#ID\``);
                    return;
                }

                // Resolve Entry
                let entry: any = null;
                const sidMatch = targetIdentifier.match(/^#?([a-z0-9]{5})$/i);
                if (sidMatch) {
                    entry = getAtlasEntryByShortId(campaignId, sidMatch[1]);
                } else if (targetIdentifier.includes('|')) {
                    const locParts = targetIdentifier.split('|').map(s => s.trim());
                    if (locParts.length === 2) {
                        entry = getAtlasEntryFull(campaignId, locParts[0], locParts[1]);
                    }
                } else {
                    // Try exact micro search
                    const all = listAllAtlasEntries(campaignId);
                    entry = all.find((e: any) => e.micro_location.toLowerCase() === targetIdentifier.toLowerCase());
                }

                if (!entry) {
                    await ctx.message.reply(`❌ Luogo **${targetIdentifier}** non trovato.`);
                    return;
                }

                const config: any = {
                    tableName: 'atlas_history',
                    entityKeyColumn: 'macro_location',
                    entityKeyValue: entry.macro_location,
                    campaignId: campaignId,
                    entityDisplayName: `${entry.macro_location} - ${entry.micro_location}`,
                    entityEmoji: '🌍',
                    secondaryKeyColumn: 'micro_location',
                    secondaryKeyValue: entry.micro_location
                };

                const { handleEventAdd, handleEventUpdate, handleEventDelete } = require('../utils/eventInteractive');

                if (mode === 'ADD') {
                    await handleEventAdd(ctx, config);
                } else if (mode === 'UPDATE') {
                    await handleEventUpdate(ctx, config);
                } else {
                    await handleEventDelete(ctx, config);
                }
                return;
            }

            const target = remainder.join(' ').trim().toLowerCase();

            if (remainder.length === 0 || target === 'list' || target === 'lista') {
                await startAtlasEventsInteractiveSelection(ctx);
                return;
            }

            // Try to parse page number
            let page = 1;
            let locTarget = remainder.join(' ');
            const lastArg = remainder[remainder.length - 1];
            if (remainder.length > 1 && !isNaN(parseInt(lastArg))) {
                page = parseInt(lastArg);
                locTarget = remainder.slice(0, -1).join(' ');
            }

            const found = await showAtlasEventsByIdentifier(ctx, locTarget, page);
            if (!found) {
                await ctx.message.reply(`❌ Luogo **${locTarget}** non trovato.`);
            }
            return;
        }

        const generateLocationDetailEmbed = (entry: any) => {
            const lastUpdate = new Date(entry.last_updated).toLocaleDateString('it-IT');
            const embed = new EmbedBuilder()
                .setTitle(`🌍 ${entry.macro_location} - 🏠 ${entry.micro_location}`)
                .setColor("#0099FF")
                .setDescription(entry.description || "*Nessuna descrizione.*")
                .addFields(
                    { name: "ID", value: `\`#${entry.short_id}\``, inline: true },
                    { name: "Ultimo Aggiornamento", value: lastUpdate, inline: true }
                );

            // 🆕 Show faction affiliations
            const factionAffiliations = factionRepository.getEntityFactions('location', entry.id);
            if (factionAffiliations.length > 0) {
                const factionText = factionAffiliations.map((a: any) => {
                    const roleIcon = a.role === 'CONTROLLED' ? '🏛️' : a.role === 'ALLY' ? '🤝' : a.role === 'ENEMY' ? '⚔️' : '📍';
                    return `${roleIcon} ${a.faction_name} (${a.role})`;
                }).join('\n');
                embed.addFields({ name: "⚔️ Fazioni", value: factionText });
            }

            embed.setFooter({ text: `Usa $atlante update ${entry.short_id} | <Nota> per aggiornare.` });
            return embed;
        };

        // --- SESSION SPECIFIC: $atlante <session_id> ---
        if (argsStr && isSessionId(argsStr)) {
            const sessionId = extractSessionId(argsStr);
            const travelLog = getSessionTravelLog(sessionId);

            if (travelLog.length === 0) {
                await ctx.message.reply(`📖 Nessun luogo visitato nella sessione \`${sessionId}\`.`);
                return;
            }

            // Group unique locations
            const uniqueLocations = new Map<string, { macro: string, micro: string, count: number }>();
            travelLog.forEach((h: any) => {
                const key = `${h.macro_location}|${h.micro_location}`;
                if (uniqueLocations.has(key)) {
                    uniqueLocations.get(key)!.count++;
                } else {
                    uniqueLocations.set(key, { macro: h.macro_location, micro: h.micro_location, count: 1 });
                }
            });

            let msg = `**📖 Luoghi Visitati nella Sessione \`${sessionId}\`:**\n`;
            uniqueLocations.forEach((loc) => {
                const entry = getAtlasEntry(ctx.activeCampaign!.id, loc.macro, loc.micro);
                const hasDesc = entry ? '📝' : '❔';
                msg += `${hasDesc} 🌍 **${loc.macro}** - 🏠 ${loc.micro}`;
                if (loc.count > 1) msg += ` *(${loc.count}x)*`;
                msg += '\n';
            });
            msg += `\n💡 Usa \`$atlante <Regione> | <Luogo>\` per vedere i dettagli.`;

            await ctx.message.reply(msg);
            return;
        }

        // --- SUBCOMMAND: add ---
        if (argsStr.toLowerCase() === 'add' || argsStr.toLowerCase().startsWith('add ')) {
            const content = argsStr.substring(3).trim();
            if (!content) {
                await startInteractiveAtlasAdd(ctx);
                return;
            }
        }

        // --- SUBCOMMAND: update ---
        if (argsStr.toLowerCase() === 'update' || argsStr.toLowerCase().startsWith('update ')) {
            const content = argsStr.substring(7).trim();

            if (!content) {
                await startInteractiveAtlasUpdate(ctx);
                return;
            }
            // ID or Macro|Micro
            // $atlante update 1 | Note
            // $atlante update Region | Place | Note

            const parts = content.split('|').map(s => s.trim());

            let macro = '';
            let micro = '';
            let note = '';

            // ID Resolution
            const sidMatch = parts[0].match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const entry = getAtlasEntryByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (entry) {
                    macro = entry.macro_location;
                    micro = entry.micro_location;
                    note = parts.slice(1).join('|').trim();
                } else {
                    await ctx.message.reply(`❌ ID \`#${sidMatch[1]}\` non trovato.`);
                    return;
                }
            } else {
                // Name Mode: Region | Place | Note
                if (parts.length < 3) {
                    await ctx.message.reply('Uso: `$atlante update <Regione> | <Luogo> | <Nota>`');
                    return;
                }
                macro = parts[0];
                micro = parts[1];
                note = parts.slice(2).join('|').trim();
            }

            addAtlasEvent(ctx.activeCampaign!.id, macro, micro, null, note, "MANUAL_UPDATE", true);
            await ctx.message.reply(`📝 Nota aggiunta a **${macro} - ${micro}**. Aggiornamento atmosfera...`);

            await syncAtlasEntryIfNeeded(ctx.activeCampaign!.id, macro, micro, true);
            return;
        }

        // --- SUBCOMMAND: delete ---
        if (argsStr.toLowerCase().startsWith('delete ') || argsStr.toLowerCase().startsWith('elimina ')) {
            const deleteArgs = argsStr.substring(argsStr.indexOf(' ') + 1);
            let macro = '';
            let micro = '';

            const sidMatch = deleteArgs.match(/^#([a-z0-9]{5})$/i);

            if (sidMatch) {
                const entry = getAtlasEntryByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (entry) {
                    macro = entry.macro_location;
                    micro = entry.micro_location;
                } else {
                    await ctx.message.reply(`❌ ID \`#${sidMatch[1]}\` non trovato.`);
                    return;
                }
            } else {
                const parts = deleteArgs.split('|').map(s => s.trim());
                if (parts.length !== 2) {
                    await ctx.message.reply('Uso: `$atlante delete <Regione> | <Luogo>` o `$atlante delete <ID>`');
                    return;
                }
                macro = parts[0];
                micro = parts[1];
            }

            // Full Wipe: RAG + History + Entry
            await ctx.message.reply(`🗑️ Eliminazione completa per **${macro} - ${micro}** in corso...`);

            // 1. Delete RAG Summary
            deleteAtlasRagSummary(ctx.activeCampaign!.id, macro, micro);

            // 2. Delete History
            deleteAtlasHistory(ctx.activeCampaign!.id, macro, micro);

            // 3. Delete Entry
            const success = deleteAtlasEntry(ctx.activeCampaign!.id, macro, micro);

            if (success) {
                await ctx.message.reply(`✅ Voce **${macro} - ${micro}** eliminata definitivamente (RAG, Storia, Atlante).`);
            } else {
                await ctx.message.reply(`❌ Luogo **${macro} - ${micro}** non trovato.`);
            }
            return;
        }

        // SUBCOMMAND: events - $atlante <id/#id|macro|micro> events [page]
        const eventsMatch = argsStr.match(/^(.+?)\s+(events|eventi)(?:\s+(\d+))?$/i);
        if (eventsMatch) {
            let locIdentifier = eventsMatch[1].trim();
            const page = eventsMatch[3] ? parseInt(eventsMatch[3]) : 1;

            const found = await showAtlasEventsByIdentifier(ctx, locIdentifier, page);
            if (!found) {
                await ctx.message.reply(`❌ Luogo **${locIdentifier}** non trovato.`);
            }
            return;
        }

        // --- VIEW SPECIFIC LOCATION (ID or Macro|Micro) ---
        const parts = argsStr.split('|').map(s => s.trim());
        const sidMatchDetail = parts[0].match(/^#([a-z0-9]{5})$/i);

        if ((parts.length === 1 && sidMatchDetail) || parts.length === 2) {
            let entry: any = null;

            if (sidMatchDetail) {
                entry = getAtlasEntryByShortId(ctx.activeCampaign!.id, sidMatchDetail[1]);
            } else if (parts.length === 2) {
                const [macro, micro] = parts;
                entry = getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);
            }

            if (entry) {
                await ctx.message.reply({ embeds: [generateLocationDetailEmbed(entry)] });
            } else {
                if (sidMatchDetail) {
                    await ctx.message.reply(`❌ ID \`#${sidMatchDetail[1]}\` non trovato.`);
                } else {
                    await ctx.message.reply(
                        `📖 **${parts[0]} - ${parts[1]}** non è ancora nell'Atlante.\n` +
                        `💡 Usa \`$atlante update ${parts[0]} | ${parts[1]} | <descrizione>\` per aggiungerlo.`
                    );
                }
            }
            return;
        }

        // --- LIST / PAGINATION ---
        // Default view or explicit list command
        if (!argsStr || argsStr.toLowerCase().startsWith('list') || argsStr.toLowerCase().startsWith('lista')) {
            let initialPage = 1;
            if (argsStr) {
                const listParts = argsStr.split(' ');
                if (listParts.length > 1 && !isNaN(parseInt(listParts[1]))) {
                    initialPage = parseInt(listParts[1]);
                }
            }

            const ITEMS_PER_PAGE = 5;
            let currentPage = Math.max(0, initialPage - 1);

            const generateEmbed = (page: number) => {
                const offset = page * ITEMS_PER_PAGE;
                const entries = listAtlasEntries(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);
                const total = countAtlasEntries(ctx.activeCampaign!.id);
                const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

                if (entries.length === 0 && total > 0 && page > 0) {
                    return { embed: new EmbedBuilder().setDescription("❌ Pagina inesistente."), totalPages: Math.ceil(total / ITEMS_PER_PAGE) };
                }

                if (total === 0) {
                    return { embed: new EmbedBuilder().setDescription("📖 L'Atlante è vuoto."), totalPages: 0 };
                }

                const list = entries.map((e: any) => {
                    const descPreview = (e.description && e.description.trim().length > 0)
                        ? `\n> *${e.description.substring(0, 80)}${e.description.length > 80 ? '...' : ''}*`
                        : '';
                    return `\`#${e.short_id}\` 🗺️ **${e.macro_location}** - *${e.micro_location}*${descPreview}`;
                }).join('\n\n');

                const embed = new EmbedBuilder()
                    .setTitle(`📖 Atlante (${ctx.activeCampaign?.name})`)
                    .setColor("#0099FF")
                    .setDescription(list)
                    .setFooter({ text: `Pagina ${page + 1} di ${totalPages} • Totale: ${total}` });

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

            const generateSelectMenu = (entries: any[]) => {
                if (entries.length === 0) return null;

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_location')
                    .setPlaceholder('🔍 Seleziona un luogo per i dettagli...')
                    .addOptions(
                        entries.map((e: any) =>
                            new StringSelectMenuOptionBuilder()
                                .setLabel(`${e.macro_location} - ${e.micro_location}`.substring(0, 100))
                                .setDescription(`ID: #${e.short_id}`)
                                .setValue(`${e.macro_location}|${e.micro_location}`)
                                .setEmoji('🌍')
                        )
                    );

                return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
            };

            const initialData = generateEmbed(currentPage);
            const offset = currentPage * ITEMS_PER_PAGE;
            const currentEntries = listAtlasEntries(ctx.activeCampaign!.id, ITEMS_PER_PAGE, offset);

            // If empty or error
            if (initialData.totalPages === 0 || !initialData.embed.data.title) {
                await ctx.message.reply({ embeds: [initialData.embed] });
                return;
            }

            const components: any[] = [];
            if (initialData.totalPages > 1) components.push(generateButtons(currentPage, initialData.totalPages));
            const selectRow = generateSelectMenu(currentEntries);
            if (selectRow) components.push(selectRow);

            const reply = await ctx.message.reply({
                embeds: [initialData.embed],
                components
            });

            if (initialData.totalPages > 1 || currentEntries.length > 0) {
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
                        const newEntries = listAtlasEntries(ctx.activeCampaign!.id, ITEMS_PER_PAGE, newOffset);

                        const newComponents: any[] = [];
                        if (newData.totalPages > 1) newComponents.push(generateButtons(currentPage, newData.totalPages));
                        const newSelectRow = generateSelectMenu(newEntries);
                        if (newSelectRow) newComponents.push(newSelectRow);

                        await interaction.update({
                            embeds: [newData.embed],
                            components: newComponents
                        });
                    } else if (interaction.isStringSelectMenu()) {
                        if (interaction.customId === 'select_location') {
                            const [macro, micro] = interaction.values[0].split('|');
                            const entry = getAtlasEntryFull(ctx.activeCampaign!.id, macro, micro);
                            if (entry) {
                                const detailEmbed = generateLocationDetailEmbed(entry);
                                await interaction.reply({ embeds: [detailEmbed] });
                            } else {
                                await interaction.reply({ content: "Luogo non trovato.", ephemeral: true });
                            }
                        }
                    }
                });

                collector.on('end', () => {
                    reply.edit({ components: [] }).catch(() => { });
                });
            }
            return;
        }

        // --- FALLBACK ---
        // --- FALLBACK: Help ---
        await ctx.message.reply(
            `**📖 Uso del comando $atlante:**\n` +
            `\`$atlante\` - Mostra luogo corrente o lista\n` +
            `\`$atlante list [pag]\` - Lista luoghi con ID\n` +
            `\`$atlante <ID>\` o \`$atlante <R> | <L>\` - Vedi dettaglio\n` +
            `\`$atlante update <ID> | <Nota>\` - Aggiorna luogo\n` +
            `\`$atlante update <R> | <L> | <Nota>\` - Aggiorna luogo`
        );
    }
};

/**
 * Helper: Resolve atlas identifier and show events
 */
async function showAtlasEventsByIdentifier(ctx: CommandContext, identifier: string, page: number = 1): Promise<boolean> {
    const campaignId = ctx.activeCampaign!.id;
    let entry: any = null;

    // Resolve short ID
    const sidMatch = identifier.trim().match(/^#?([a-z0-9]{5})$/i);
    if (sidMatch) {
        entry = getAtlasEntryByShortId(campaignId, sidMatch[1]);
    } else if (identifier.includes('|')) {
        const locParts = identifier.split('|').map(s => s.trim());
        if (locParts.length === 2) {
            entry = getAtlasEntryFull(campaignId, locParts[0], locParts[1]);
        }
    } else {
        // Try as micro location name search
        const all = listAllAtlasEntries(campaignId);
        entry = all.find((e: any) =>
            e.micro_location.toLowerCase() === identifier.trim().toLowerCase() ||
            `${e.macro_location} - ${e.micro_location}`.toLowerCase() === identifier.trim().toLowerCase()
        );
    }

    if (!entry) return false;

    await showEntityEvents(ctx, {
        tableName: 'atlas_history',
        entityKeyColumn: 'macro_location',
        entityKeyValue: entry.macro_location,
        campaignId: campaignId,
        entityDisplayName: `${entry.macro_location} - ${entry.micro_location}`,
        entityEmoji: '🌍',
        secondaryKeyColumn: 'micro_location',
        secondaryKeyValue: entry.micro_location
    }, page);

    return true;
}

/**
 * Helper: Interactive selection for atlas events
 */
async function startAtlasEventsInteractiveSelection(ctx: CommandContext) {
    const campaignId = ctx.activeCampaign!.id;
    const entries = listAtlasEntries(campaignId, 25, 0);

    if (entries.length === 0) {
        await ctx.message.reply("📖 L'Atlante è vuoto.");
        return;
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_atlas_events')
        .setPlaceholder('🔍 Seleziona un luogo...')
        .addOptions(
            entries.map((e: any) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${e.macro_location} - ${e.micro_location}`.substring(0, 100))
                    .setDescription(`ID: #${e.short_id}`)
                    .setValue(`${e.macro_location}|${e.micro_location}`)
                    .setEmoji('🌍')
            )
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const reply = await ctx.message.reply({
        content: "📜 **Seleziona un luogo per vederne la cronologia:**",
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.customId === 'select_atlas_events' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const [macro, micro] = interaction.values[0].split('|');
        const entry = getAtlasEntryFull(campaignId, macro, micro);

        if (entry) {
            await interaction.update({ content: `⏳ Caricamento eventi per **${macro} - ${micro}**...`, components: [] });

            await showEntityEvents(ctx, {
                tableName: 'atlas_history',
                entityKeyColumn: 'macro_location',
                entityKeyValue: entry.macro_location,
                campaignId: campaignId,
                entityDisplayName: `${entry.macro_location} - ${entry.micro_location}`,
                entityEmoji: '🌍',
                secondaryKeyColumn: 'micro_location',
                secondaryKeyValue: entry.micro_location
            }, 1);
        } else {
            await interaction.reply({ content: "❌ Luogo non trovato.", ephemeral: true });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            await reply.edit({ content: "⏱️ Tempo scaduto per la selezione.", components: [] }).catch(() => { });
        }
    });
}
