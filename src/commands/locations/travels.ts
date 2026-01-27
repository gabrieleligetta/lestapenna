/**
 * $viaggi / $travels command - Travel history management
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageComponentInteraction } from 'discord.js';
import { Command, CommandContext } from '../types';
import {
    getLocationHistory,
    getLocationHistoryWithIds,
    getSessionTravelLog,
    fixLocationHistoryEntry,
    deleteLocationHistoryEntry,
    fixCurrentLocation,
    db
} from '../../db';
import { isSessionId, extractSessionId } from '../../utils/sessionId';

export const travelsCommand: Command = {
    name: 'travels',
    aliases: ['viaggi'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const argsStr = ctx.args.join(' ');

        // --- SESSION SPECIFIC: $viaggi <session_id> ---
        if (argsStr && isSessionId(argsStr)) {
            const sessionId = extractSessionId(argsStr);
            const travelLog = getSessionTravelLog(sessionId);

            if (travelLog.length === 0) {
                await ctx.message.reply(`📜 Nessun viaggio registrato per la sessione \`${sessionId}\`.`);
                return;
            }

            let msg = `**📜 Viaggi della Sessione \`${sessionId}\`:**\n`;
            travelLog.forEach((h: any) => {
                const time = new Date(h.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                const sessionNum = h.session_number ? `**[S${h.session_number}]** ` : '';
                msg += `\`${time}\` ${sessionNum}🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || 'Esterno'}\n`;
            });

            await ctx.message.reply(msg);
            return;
        }

        // --- SUBCOMMAND: fix (correct entry) ---
        if (argsStr.toLowerCase().startsWith('fix ') && !argsStr.toLowerCase().startsWith('fixcurrent')) {
            const fixArgs = argsStr.substring(4).trim();
            const parts = fixArgs.split('|').map(s => s.trim());

            if (parts.length !== 3) {
                await ctx.message.reply(
                    '**Uso: `$viaggi fix`**\n' +
                    '`$viaggi fix #ID | <NuovaRegione> | <NuovoLuogo>`\n' +
                    '💡 Usa `$viaggi list` per vedere gli ID delle voci.'
                );
                return;
            }

            const shortId = parts[0].replace('#', '').trim();
            const [, newMacro, newMicro] = parts;

            const entry = db.prepare('SELECT id FROM location_history WHERE short_id = ?').get(shortId) as any;
            if (entry) {
                const success = fixLocationHistoryEntry(entry.id, newMacro, newMicro);
                if (success) {
                    await ctx.message.reply(`✅ **Voce #${shortId} corretta!**\n📍 ${newMacro} - ${newMicro}`);
                } else {
                    await ctx.message.reply(`❌ Errore durante la correzione della voce #${shortId}.`);
                }
            } else {
                await ctx.message.reply(`❌ Voce #${shortId} non trovata.`);
            }
            return;
        }

        // --- SUBCOMMAND: delete (delete entry) ---
        if (argsStr.toLowerCase().startsWith('delete ') || argsStr.toLowerCase().startsWith('del ') || argsStr.toLowerCase().startsWith('remove ')) {
            const shortId = argsStr.split(' ')[1].replace('#', '').trim();

            const entry = db.prepare('SELECT id FROM location_history WHERE short_id = ?').get(shortId) as any;
            if (entry) {
                const success = deleteLocationHistoryEntry(entry.id);
                if (success) {
                    await ctx.message.reply(`🗑️ Voce #${shortId} eliminata dalla cronologia viaggi.`);
                } else {
                    await ctx.message.reply(`❌ Errore durante l'eliminazione della voce #${shortId}.`);
                }
            } else {
                await ctx.message.reply(`❌ Voce #${shortId} non trovata.`);
            }
            return;
        }

        // --- SUBCOMMAND: fixcurrent (fix current position) ---
        if (argsStr.toLowerCase().startsWith('fixcurrent ') || argsStr.toLowerCase().startsWith('correggi ')) {
            const fixArgs = argsStr.substring(argsStr.indexOf(' ') + 1).trim();
            const parts = fixArgs.split('|').map(s => s.trim());

            if (parts.length !== 2) {
                await ctx.message.reply(
                    '**Uso: `$viaggi fixcurrent`**\n' +
                    '`$viaggi fixcurrent <NuovaRegione> | <NuovoLuogo>`\n' +
                    'Corregge la posizione corrente della campagna.'
                );
                return;
            }

            const [newMacro, newMicro] = parts;
            fixCurrentLocation(ctx.activeCampaign!.id, newMacro, newMicro);
            await ctx.message.reply(`✅ **Posizione corrente aggiornata!**\n📍 ${newMacro} - ${newMicro}`);
            return;
        }

        // --- LIST / PAGINATION ---
        // Default view or explicit list command
        // $viaggi list [page]
        let initialPage = 1;
        if (argsStr.toLowerCase().startsWith('list') || argsStr.toLowerCase().startsWith('lista')) {
            const parts = argsStr.split(' ');
            if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                initialPage = parseInt(parts[1]);
            }
        }

        const ITEMS_PER_PAGE = 10;
        let currentPage = Math.max(0, initialPage - 1);

        // We need a paginated fetcher for history. 
        // Existing `getLocationHistoryWithIds` fetches ALL.
        // We can slice it in memory for now since history isn't massive yet, 
        // or we should add pagination to DB. For consistency with other commands, let's slice.
        const fullHistory = getLocationHistoryWithIds(ctx.activeCampaign!.id);

        const generateEmbed = (page: number) => {
            const offset = page * ITEMS_PER_PAGE;
            const items = fullHistory.slice(offset, offset + ITEMS_PER_PAGE);
            const total = fullHistory.length;
            const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

            if (items.length === 0 && total > 0 && page > 0) {
                return { embed: new EmbedBuilder().setDescription("❌ Pagina inesistente."), totalPages: Math.ceil(total / ITEMS_PER_PAGE) };
            }

            if (total === 0) {
                return { embed: new EmbedBuilder().setDescription("Il diario di viaggio è vuoto."), totalPages: 0 };
            }

            const list = items.map((h: any) => {
                const time = new Date(h.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
                const sessionNum = h.session_number ? `**[S${h.session_number}]** ` : '';
                return `\`#${h.short_id}\` \`${h.session_date} ${time}\` ${sessionNum}🌍 **${h.macro_location || '-'}** 👉 🏠 ${h.micro_location || 'Esterno'}`;
            }).join('\n');

            const embed = new EmbedBuilder()
                .setTitle(`📜 Diario di Viaggio (${ctx.activeCampaign?.name})`)
                .setColor("#95A5A6")
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

        const initialData = generateEmbed(currentPage);

        if (initialData.totalPages === 0 || !initialData.embed.data.title) {
            await ctx.message.reply({ embeds: [initialData.embed] });
            return;
        }

        const reply = await ctx.message.reply({
            embeds: [initialData.embed],
            components: initialData.totalPages > 1 ? [generateButtons(currentPage, initialData.totalPages)] : []
        });

        if (initialData.totalPages > 1) {
            const collector = reply.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 60000 * 5 // 5 minutes
            });

            collector.on('collect', async (interaction: MessageComponentInteraction) => {
                if (interaction.user.id !== ctx.message.author.id) {
                    await interaction.reply({ content: "Solo chi ha invocato il comando può sfogliare le pagine.", ephemeral: true });
                    return;
                }

                if (interaction.customId === 'prev_page') {
                    currentPage = Math.max(0, currentPage - 1);
                } else if (interaction.customId === 'next_page') {
                    currentPage++;
                }

                const newData = generateEmbed(currentPage);
                await interaction.update({
                    embeds: [newData.embed],
                    components: [generateButtons(currentPage, newData.totalPages)]
                });
            });

            collector.on('end', () => {
                reply.edit({ components: [] }).catch(() => { });
            });
        }
    }
};
