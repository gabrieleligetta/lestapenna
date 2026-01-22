/**
 * $quest / $obiettivi command - Quest management
 */

import { Command, CommandContext } from '../types';
import {
    addQuest,
    getOpenQuests,
    updateQuestStatus,
    updateQuestStatusById,
    deleteQuest,
    getSessionQuests,
    mergeQuests
} from '../../db';
import { guildSessions } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';

export const questCommand: Command = {
    name: 'quest',
    aliases: ['obiettivi'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');
        const firstArg = ctx.args[0];

        // --- SESSION SPECIFIC: $quest <session_id> [all] ---
        if (firstArg && isSessionId(firstArg)) {
            const sessionId = extractSessionId(firstArg);
            const showAll = ctx.args.includes('all') || ctx.args.includes('-a');
            const sessionQuests = getSessionQuests(sessionId);

            if (sessionQuests.length === 0) {
                await ctx.message.reply(
                    `🗺️ Nessuna quest aggiunta nella sessione \`${sessionId}\`.\n` +
                    `*Nota: Solo le quest aggiunte dopo l'aggiornamento vengono tracciate per sessione.*`
                );
                return;
            }

            const filteredQuests = showAll ? sessionQuests : sessionQuests.filter((q: any) => {
                const isCompletedStatus = q.status === 'COMPLETED';
                const title = q.title.toUpperCase();
                const isCompletedText = title.includes('(COMPLETATA') || title.includes('(PARZIALMENTE COMPLETATA');
                return !isCompletedStatus && !isCompletedText;
            });

            if (filteredQuests.length === 0) {
                await ctx.message.reply(`🗺️ Nessuna quest **attiva** trovata per la sessione \`${sessionId}\` (su ${sessionQuests.length} registrate).\n💡 Usa \`$quest ${sessionId} all\` per vederle tutte.`);
                return;
            }

            const list = filteredQuests.map((q: any) => {
                const statusIcon = q.status === 'COMPLETED' ? '✅' : q.status === 'FAILED' ? '❌' : '🔹';
                return `${statusIcon} **${q.title}** [${q.status}]`;
            }).join('\n');

            const header = showAll ? `Quest della Sessione \`${sessionId}\`` : `Quest Attive della Sessione \`${sessionId}\``;
            await ctx.message.reply(`**🗺️ ${header}:**\n\n${list}`);
            return;
        }

        // SUBCOMMAND: $quest add <Title>
        if (arg.toLowerCase().startsWith('add ')) {
            const title = arg.substring(4);
            const currentSession = guildSessions.get(ctx.guildId);
            addQuest(ctx.activeCampaign!.id, title, currentSession);
            await ctx.message.reply(`🗺️ Quest aggiunta: **${title}**`);
            return;
        }

        // SUBCOMMAND: $quest done <Title or ID>
        if (arg.toLowerCase().startsWith('done ') || arg.toLowerCase().startsWith('completata ')) {
            const search = arg.split(' ').slice(1).join(' ');

            const questId = parseInt(search);
            if (!isNaN(questId)) {
                const success = updateQuestStatusById(questId, 'COMPLETED');
                if (success) await ctx.message.reply(`✅ Quest #${questId} completata!`);
                else await ctx.message.reply(`❌ Quest #${questId} non trovata.`);
                return;
            }

            updateQuestStatus(ctx.activeCampaign!.id, search, 'COMPLETED');
            await ctx.message.reply(`✅ Quest aggiornata come completata (ricerca: "${search}")`);
            return;
        }

        // SUBCOMMAND: $quest delete <ID>
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('del ') || arg.toLowerCase().startsWith('remove ') || arg.toLowerCase().startsWith('rm ')) {
            const idStr = arg.split(' ')[1];
            const questId = parseInt(idStr);

            if (isNaN(questId)) {
                await ctx.message.reply("Uso: `$quest delete <ID>` (L'ID deve essere un numero)");
                return;
            }

            const success = deleteQuest(questId);
            if (success) {
                await ctx.message.reply(`🗑️ Quest #${questId} eliminata definitivamente.`);
            } else {
                await ctx.message.reply(`❌ Quest #${questId} non trovata.`);
            }
            return;
        }

        // VIEW: Show active quests
        const quests = getOpenQuests(ctx.activeCampaign!.id);
        if (quests.length === 0) {
            await ctx.message.reply("Nessuna quest attiva al momento.");
            return;
        }

        const list = quests.map((q: any) => `\`#${q.id}\` 🔹 **${q.title}**`).join('\n');
        await ctx.message.reply(`**🗺️ Quest Attive (${ctx.activeCampaign?.name})**\n\n${list}\n\n💡 Usa \`$quest done <ID>\` per completare o \`$quest delete <ID>\` per eliminare.`);
    }
};

export const mergeQuestCommand: Command = {
    name: 'mergequest',
    aliases: ['unisciquest', 'mergequests'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');
        const parts = arg.split('|').map(s => s.trim());

        if (parts.length !== 2) {
            await ctx.message.reply("Uso: `$unisciquest <titolo vecchio> | <titolo nuovo>`\nEsempio: `$unisciquest Trova l'artefatto | Trovare l'artefatto antico`");
            return;
        }

        const [oldTitle, newTitle] = parts;
        const success = mergeQuests(ctx.activeCampaign!.id, oldTitle, newTitle);
        if (success) {
            await ctx.message.reply(`✅ **Quest unite!**\n🗺️ **${oldTitle}** è stata integrata in **${newTitle}**`);
        } else {
            await ctx.message.reply(`❌ Impossibile unire. Verifica che "${oldTitle}" esista tra le quest.`);
        }
    }
};
