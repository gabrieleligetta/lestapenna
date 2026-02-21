/**
 * $artifact / $artefatto command - Magical artifacts registry
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    listAllArtifacts,
    mergeArtifacts,
    addArtifactEvent,
    getArtifactByName,
    getArtifactHistory,
    getArtifactByShortId,
    deleteArtifact,
    updateArtifactFields,
    upsertArtifact
} from '../../db';
import { ArtifactEntry, ArtifactStatus } from '../../db/types';
import { guildSessions } from '../../state/sessionState';
import { showEntityEvents } from '../utils/eventsViewer';
import { startInteractiveArtifactUpdate, startInteractiveArtifactAdd, startInteractiveArtifactDelete } from './artifactInteractive';
import { startInteractiveMerge, MergeConfig } from '../utils/mergeInteractive';

// Status icons and colors
const getStatusDisplay = (status: ArtifactStatus) => {
    switch (status) {
        case 'FUNCTIONAL': return { icon: '✨', color: '#00FF00' as const, label: 'Funzionante' };
        case 'DESTROYED': return { icon: '💥', color: '#FF0000' as const, label: 'Distrutto' };
        case 'LOST': return { icon: '❓', color: '#808080' as const, label: 'Perduto' };
        case 'SEALED': return { icon: '🔒', color: '#9932CC' as const, label: 'Sigillato' };
        case 'DORMANT': return { icon: '💤', color: '#4169E1' as const, label: 'Dormiente' };
        default: return { icon: '🔮', color: '#7289DA' as const, label: status };
    }
};

export const artifactCommand: Command = {
    name: 'artifact',
    aliases: ['artefatto', 'artefatti', 'artifacts'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const firstArg = ctx.args[0]?.toLowerCase();
        const arg = ctx.args.join(' ');

        if (firstArg === 'delete') {
            await startInteractiveArtifactDelete(ctx);
            return;
        }

        // 🆕 Events Subcommand: $artifact events [action] [nome/ID]
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
                    await ctx.message.reply(`❌ Specifica un artefatto: \`$artifact events ${action} <Nome>\``);
                    return;
                }

                // Resolve Artifact
                let artifact = getArtifactByName(campaignId, targetIdentifier);
                if (!artifact) {
                    const byShort = getArtifactByShortId(campaignId, targetIdentifier);
                    if (byShort) artifact = byShort;
                }

                if (!artifact) {
                    await ctx.message.reply(`❌ Artefatto **${targetIdentifier}** non trovato.`);
                    return;
                }

                const config: any = {
                    tableName: 'artifact_history',
                    entityKeyColumn: 'artifact_name',
                    entityKeyValue: artifact.name,
                    campaignId: campaignId,
                    entityDisplayName: artifact.name,
                    entityEmoji: '🔮'
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
                await startArtifactEventsInteractiveSelection(ctx);
                return;
            }

            // Try to parse page number
            let page = 1;
            let artifactTarget = remainder.join(' ');
            const lastArg = remainder[remainder.length - 1];
            if (remainder.length > 1 && !isNaN(parseInt(lastArg))) {
                page = parseInt(lastArg);
                artifactTarget = remainder.slice(0, -1).join(' ');
            }

            const found = await showArtifactEventsByIdentifier(ctx, artifactTarget, page);
            if (!found) {
                await ctx.message.reply(`❌ Artefatto **${artifactTarget}** non trovato.`);
            }
            return;
        }

        const generateArtifactDetailEmbed = (artifact: ArtifactEntry) => {
            const statusDisplay = getStatusDisplay(artifact.status);

            const embed = new EmbedBuilder()
                .setTitle(`${statusDisplay.icon} ${artifact.name}`)
                .setColor(statusDisplay.color)
                .setDescription(artifact.description || "*Nessuna descrizione.*")
                .addFields(
                    { name: "Stato", value: statusDisplay.label, inline: true },
                    { name: "ID", value: `\`#${artifact.short_id}\``, inline: true }
                );

            if (artifact.effects) embed.addFields({ name: "⚡ Effetti", value: artifact.effects });

            if (artifact.is_cursed) {
                embed.addFields({
                    name: "☠️ Maledetto",
                    value: artifact.curse_description || "Sì - Dettagli sconosciuti"
                });
            }

            if (artifact.owner_name) {
                embed.addFields({
                    name: "👤 Proprietario",
                    value: `${artifact.owner_name} (${artifact.owner_type || 'Sconosciuto'})`,
                    inline: true
                });
            }

            if (artifact.location_macro || artifact.location_micro) {
                const location = [artifact.location_macro, artifact.location_micro].filter(Boolean).join(' - ');
                embed.addFields({ name: "📍 Posizione", value: location, inline: true });
            }

            embed.setFooter({ text: `Usa $artifact update ${artifact.short_id} | <Nota> per aggiornare.` });
            return embed;
        };

        // SUBCOMMAND: $artifact update <Name or ID> [| <Note> OR <field> <value>]
        if (arg.toLowerCase().startsWith('update')) { // Changed from 'update ' to 'update' to catch bare command
            const fullContent = arg.substring(6).trim(); // Changed substring index

            if (!fullContent) {
                await startInteractiveArtifactUpdate(ctx);
                return;
            }

            let targetIdentifier = "";
            let remainingArgs = "";

            if (fullContent.startsWith('#')) {
                const parts = fullContent.split(' ');
                targetIdentifier = parts[0];
                remainingArgs = parts.slice(1).join(' ');
            } else {
                if (fullContent.includes('|')) {
                    targetIdentifier = fullContent.split('|')[0].trim();
                    remainingArgs = "|" + fullContent.split('|').slice(1).join('|');
                } else {
                    const keywords = ['status', 'stato', 'owner', 'proprietario', 'cursed', 'maledetto'];
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

            // Resolve Artifact
            let artifact: ArtifactEntry | null = null;
            const sidMatch = targetIdentifier.match(/^#?([a-z0-9]{5})$/i);

            if (sidMatch) {
                artifact = getArtifactByShortId(ctx.activeCampaign!.id, sidMatch[1]);
            }
            if (!artifact) {
                artifact = getArtifactByName(ctx.activeCampaign!.id, targetIdentifier);
            }

            if (!artifact) {
                await ctx.message.reply(`❌ Artefatto "${targetIdentifier}" non trovato.`);
                return;
            }

            // Case A: Narrative Update
            if (remainingArgs.trim().startsWith('|')) {
                const note = remainingArgs.replace('|', '').trim();
                const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
                addArtifactEvent(ctx.activeCampaign!.id, artifact.name, currentSession, note, "MANUAL_UPDATE", true);

                await ctx.message.reply(`📝 Nota aggiunta a **${artifact.name}**.`);
                return;
            }

            // Case B: Metadata Update
            const args = remainingArgs.trim().split(/\s+/);
            const field = args[0]?.toLowerCase();
            const value = args.slice(1).join(' ');

            const showUpdateHelp = async (errorMsg?: string) => {
                const statusDisplay = getStatusDisplay(artifact!.status);
                const embed = new EmbedBuilder()
                    .setTitle(`ℹ️ Aggiornamento Artefatto: #${artifact!.short_id} "${artifact!.name}"`)
                    .setColor("#3498DB")
                    .setDescription(errorMsg ? `⚠️ **${errorMsg}**\n\n` : "")
                    .addFields(
                        {
                            name: "Valori Attuali",
                            value: `**Status:** ${statusDisplay.icon} ${statusDisplay.label}\n**Maledetto:** ${artifact!.is_cursed ? 'Sì' : 'No'}\n**Proprietario:** ${artifact!.owner_name || 'Nessuno'}`,
                            inline: false
                        },
                        {
                            name: "Campi Modificabili",
                            value: `
• **status**: FUNZIONANTE, DISTRUTTO, PERDUTO, SIGILLATO, DORMIENTE
  *Es: $artifact update #${artifact!.short_id} status DISTRUTTO*
• **owner**: Nome del nuovo proprietario
  *Es: $artifact update #${artifact!.short_id} owner Gandalf*
• **cursed**: true/false
  *Es: $artifact update #${artifact!.short_id} cursed true*
• **Note Narrative** (usa | )
  *Es: $artifact update #${artifact!.short_id} | L'artefatto emana una luce sinistra*`
                        }
                    );
                await ctx.message.reply({ embeds: [embed] });
            };

            if (!field || !value) {
                await showUpdateHelp("Specifica un campo e un valore.");
                return;
            }

            switch (field) {
                case 'status':
                case 'stato': {
                    const statusMap: Record<string, string> = {
                        'FUNZIONANTE': 'FUNCTIONAL', 'FUNCTIONAL': 'FUNCTIONAL',
                        'DISTRUTTO': 'DESTROYED', 'DESTROYED': 'DESTROYED',
                        'PERDUTO': 'LOST', 'LOST': 'LOST',
                        'SIGILLATO': 'SEALED', 'SEALED': 'SEALED',
                        'DORMIENTE': 'DORMANT', 'DORMANT': 'DORMANT'
                    };
                    const upperValue = value.toUpperCase();
                    const mappedStatus = statusMap[upperValue];
                    if (!mappedStatus) {
                        await showUpdateHelp(`Status "${value}" non valido.`);
                        return;
                    }
                    updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { status: mappedStatus as ArtifactStatus }, true);
                    await ctx.message.reply(`✅ **${artifact.name}** stato aggiornato a **${upperValue}**`);
                    break;
                }
                case 'owner':
                case 'proprietario': {
                    updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { owner_name: value }, true);
                    await ctx.message.reply(`✅ **${artifact.name}** proprietario aggiornato: **${value}**`);
                    break;
                }
                case 'cursed':
                case 'maledetto': {
                    const isCursed = value.toLowerCase() === 'true' || value.toLowerCase() === 'sì' || value === '1';
                    updateArtifactFields(ctx.activeCampaign!.id, artifact.name, { is_cursed: isCursed }, true);
                    await ctx.message.reply(`✅ **${artifact.name}** ${isCursed ? 'è ora maledetto' : 'non è più maledetto'}`);
                    break;
                }
                default:
                    await showUpdateHelp(`Campo "${field}" non riconosciuto.`);
            }
            return;
        }

        // SUBCOMMAND: $artifact delete <Name or ID>
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            const target = arg.replace(/^(delete|elimina)\s+/i, '').trim();

            let artifact: ArtifactEntry | null = null;
            const sidMatch = target.match(/^#?([a-z0-9]{5})$/i);
            if (sidMatch) {
                artifact = getArtifactByShortId(ctx.activeCampaign!.id, sidMatch[1]);
            }
            if (!artifact) {
                artifact = getArtifactByName(ctx.activeCampaign!.id, target);
            }

            if (!artifact) {
                await ctx.message.reply(`❌ Artefatto "${target}" non trovato.`);
                return;
            }

            const confirm = new ButtonBuilder().setCustomId('confirm_delete').setLabel('Elimina').setStyle(ButtonStyle.Danger);
            const cancel = new ButtonBuilder().setCustomId('cancel_delete').setLabel('Annulla').setStyle(ButtonStyle.Secondary);
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel);

            const msg = await ctx.message.reply({
                content: `⚠️ Sei sicuro di voler eliminare **${artifact.name}** (#${artifact.short_id})? Questa azione è irreversibile.`,
                components: [row]
            });

            try {
                const i = await msg.awaitMessageComponent({ componentType: ComponentType.Button, time: 30000 });
                if (i.customId === 'confirm_delete') {
                    deleteArtifact(ctx.activeCampaign!.id, artifact.name);
                    await i.update({ content: `🗑️ **${artifact.name}** eliminato.`, components: [] });
                } else {
                    await i.update({ content: '❌ Operazione annullata.', components: [] });
                }
            } catch {
                await msg.edit({ content: '⏱️ Tempo scaduto.', components: [] });
            }
            return;
        }

        if (arg.toLowerCase() === 'add' || arg.toLowerCase().startsWith('add ')) {
            const content = arg.substring(3).trim();
            if (!content) {
                await startInteractiveArtifactAdd(ctx);
                return;
            }
        }

        // SUBCOMMAND: $artifact merge <old> | <new>
        if (arg.toLowerCase().startsWith('merge') || arg.toLowerCase().startsWith('unisci')) {
            const content = arg.replace(/^(merge|unisci)\s*/i, '').trim();

            const mergeConfig: MergeConfig = {
                entityType: 'Artefatto',
                emoji: '✨',
                campaignId: ctx.activeCampaign!.id,
                listEntities: (cid) => listAllArtifacts(cid).map(a => ({
                    id: a.name,
                    shortId: a.short_id || '?????',
                    name: a.name,
                    description: a.description || '',
                    metadata: a.status || ''
                })),
                resolveEntity: (cid, query) => {
                    const sidMatch = query.match(/^#([a-z0-9]{5})$/i);
                    let art = null;
                    if (sidMatch) {
                        art = getArtifactByShortId(cid, sidMatch[1]);
                    } else {
                        art = getArtifactByName(cid, query);
                    }
                    if (!art) return null;
                    return {
                        id: art.name,
                        shortId: art.short_id || '?????',
                        name: art.name,
                        description: art.description || '',
                        metadata: art.status || ''
                    };
                },
                executeMerge: async (cid, source, target, mergedDesc) => {
                    return mergeArtifacts(cid, source.name as string, target.name as string, mergedDesc || undefined);
                }
            };

            await startInteractiveMerge(ctx, mergeConfig, content);
            return;
        }

        // SUBCOMMAND: $artifact [name/#id] events [page]
        if (arg.toLowerCase().includes(' events') || arg.toLowerCase().includes(' eventi')) {
            const match = arg.match(/(.+?)\s+(events|eventi)(?:\s+(\d+))?$/i);
            if (match) {
                const identifier = match[1].trim();
                const page = match[3] ? parseInt(match[3]) : 1;

                const found = await showArtifactEventsByIdentifier(ctx, identifier, page);
                if (!found) {
                    await ctx.message.reply(`❌ Artefatto "${identifier}" non trovato.`);
                }
                return;
            }
        }

        // DEFAULT or VIEW: $artifact [list] or $artifact <name/#id>
        if (!arg || arg.toLowerCase() === 'list' || arg.toLowerCase() === 'lista') {
            const artifacts = listAllArtifacts(ctx.activeCampaign!.id);

            if (artifacts.length === 0) {
                await ctx.message.reply("📦 **Nessun artefatto registrato** in questa campagna.");
                return;
            }

            const PER_PAGE = 10;
            let page = 0;
            const totalPages = Math.ceil(artifacts.length / PER_PAGE);

            const generateListEmbed = (p: number) => {
                const start = p * PER_PAGE;
                const pageItems = artifacts.slice(start, start + PER_PAGE);

                const lines = pageItems.map(a => {
                    const statusDisplay = getStatusDisplay(a.status);
                    const cursedTag = a.is_cursed ? ' ☠️' : '';
                    return `${statusDisplay.icon} **${a.name}**${cursedTag} \`#${a.short_id}\``;
                });

                return new EmbedBuilder()
                    .setTitle(`🔮 Artefatti (${artifacts.length})`)
                    .setColor("#9932CC")
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: `Pagina ${p + 1}/${totalPages} • Usa $artifact <nome/#id> per i dettagli` });
            };

            const generateButtons = (p: number, total: number) => {
                return new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
                    new ButtonBuilder().setCustomId('next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(p >= total - 1)
                );
            };

            const generateSelectMenu = (p: number) => {
                const start = p * PER_PAGE;
                const pageItems = artifacts.slice(start, start + PER_PAGE);

                if (pageItems.length === 0) return null;

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_artifact')
                    .setPlaceholder('🔍 Seleziona un artefatto...')
                    .addOptions(
                        pageItems.map(a => {
                            const statusDisplay = getStatusDisplay(a.status);
                            return new StringSelectMenuOptionBuilder()
                                .setLabel(a.name)
                                .setDescription(`#${a.short_id} - ${statusDisplay.label}`)
                                .setValue(a.short_id || 'unknown')
                                .setEmoji(statusDisplay.icon);
                        })
                    );

                return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
            };

            const getComponents = (p: number, total: number) => {
                const comps: any[] = [];
                if (total > 1) comps.push(generateButtons(p, total));
                const menu = generateSelectMenu(p);
                if (menu) comps.push(menu);
                return comps;
            };

            const msg = await ctx.message.reply({
                embeds: [generateListEmbed(page)],
                components: getComponents(page, totalPages)
            });

            if (totalPages > 1 || artifacts.length > 0) {
                const collector = msg.createMessageComponentCollector({ time: 120000 });

                collector.on('collect', async (i: MessageComponentInteraction) => {
                    if (i.user.id !== ctx.message.author.id) {
                        await i.reply({ content: "Solo chi ha invocato il comando può interagire.", ephemeral: true });
                        return;
                    }

                    if (i.isButton()) {
                        if (i.customId === 'prev') page = Math.max(0, page - 1);
                        if (i.customId === 'next') page = Math.min(totalPages - 1, page + 1);

                        await i.update({
                            embeds: [generateListEmbed(page)],
                            components: getComponents(page, totalPages)
                        });
                    }
                    else if (i.isStringSelectMenu() && i.customId === 'select_artifact') {
                        const selectedId = i.values[0];
                        const artifact = getArtifactByShortId(ctx.activeCampaign!.id, selectedId);

                        if (artifact) {
                            await i.reply({ embeds: [generateArtifactDetailEmbed(artifact)], ephemeral: true });
                        } else {
                            await i.reply({ content: "❌ Artefatto non trovato.", ephemeral: true });
                        }
                    }
                });
            }
            return;
        }

        // View specific artifact by name or ID
        let artifact: ArtifactEntry | null = null;
        const sidMatch = arg.match(/^#?([a-z0-9]{5})$/i);
        if (sidMatch) {
            artifact = getArtifactByShortId(ctx.activeCampaign!.id, sidMatch[1]);
        }
        if (!artifact) {
            artifact = getArtifactByName(ctx.activeCampaign!.id, arg.trim());
        }

        if (!artifact) {
            await ctx.message.reply(`❌ Artefatto "${arg}" non trovato.`);
            return;
        }

        await ctx.message.reply({ embeds: [generateArtifactDetailEmbed(artifact)] });
    }
};

/**
 * Helper: Resolve artifact identifier and show events
 */
async function showArtifactEventsByIdentifier(ctx: CommandContext, identifier: string, page: number = 1): Promise<boolean> {
    const campaignId = ctx.activeCampaign!.id;
    let artifact: ArtifactEntry | null = null;

    const sidMatch = identifier.trim().match(/^#?([a-z0-9]{5})$/i);
    if (sidMatch) {
        artifact = getArtifactByShortId(campaignId, sidMatch[1]);
    }

    if (!artifact) {
        artifact = getArtifactByName(campaignId, identifier.trim());
    }

    if (!artifact) return false;

    await showEntityEvents(ctx, {
        tableName: 'artifact_history',
        entityKeyColumn: 'artifact_name',
        entityKeyValue: artifact.name,
        campaignId: campaignId,
        entityDisplayName: artifact.name,
        entityEmoji: '🔮'
    }, page);

    return true;
}

/**
 * Helper: Interactive selection for artifact events
 */
async function startArtifactEventsInteractiveSelection(ctx: CommandContext) {
    const campaignId = ctx.activeCampaign!.id;
    const artifacts = listAllArtifacts(campaignId);

    if (artifacts.length === 0) {
        await ctx.message.reply("📦 Nessun artefatto registrato in questa campagna.");
        return;
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_artifact_events')
        .setPlaceholder('🔍 Seleziona un artefatto...')
        .addOptions(
            artifacts.slice(0, 25).map(a => {
                const statusDisplay = getStatusDisplay(a.status);
                return new StringSelectMenuOptionBuilder()
                    .setLabel(a.name.substring(0, 100))
                    .setDescription(`#${a.short_id} - ${statusDisplay.label}`)
                    .setValue(a.name)
                    .setEmoji(statusDisplay.icon);
            })
        );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    const reply = await ctx.message.reply({
        content: "📜 **Seleziona un artefatto per vederne la cronologia:**",
        components: [row]
    });

    const collector = reply.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000,
        filter: (i) => i.customId === 'select_artifact_events' && i.user.id === ctx.message.author.id
    });

    collector.on('collect', async (interaction) => {
        const artifactName = interaction.values[0];
        const artifact = getArtifactByName(campaignId, artifactName);

        if (artifact) {
            // Remove components and show events
            await interaction.update({ content: `⏳ Caricamento eventi per **${artifact.name}**...`, components: [] });

            await showEntityEvents(ctx, {
                tableName: 'artifact_history',
                entityKeyColumn: 'artifact_name',
                entityKeyValue: artifact.name,
                campaignId: campaignId,
                entityDisplayName: artifact.name,
                entityEmoji: '🔮'
            }, 1);
        } else {
            await interaction.reply({ content: "❌ Artefatto non trovato.", ephemeral: true });
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            await reply.edit({ content: "⏱️ Tempo scaduto per la selezione.", components: [] }).catch(() => { });
        }
    });
}
