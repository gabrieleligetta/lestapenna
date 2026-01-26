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
    mergeQuests,
    // New imports
    addQuestEvent,
    getQuestHistory,
    getQuestByTitle,
    deleteQuestHistory,
    deleteQuestRagSummary
} from '../../db';
import { questRepository } from '../../db/repositories/QuestRepository';
import { guildSessions } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { generateBio } from '../../bard/bio';

// Helper for Regen
async function regenerateQuestBio(campaignId: number, title: string, status: string) {
    const history = getQuestHistory(campaignId, title);
    // Map history to simple objects
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('QUEST', { campaignId, name: title, role: status, currentDesc: "" }, simpleHistory);
}

export const questCommand: Command = {
    name: 'quest',
    aliases: ['obiettivi'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');
        const firstArg = ctx.args[0];

        // --- SESSION SPECIFIC: $quest <session_id> [all] ---
        if (firstArg && isSessionId(firstArg)) {
            // ... (Keep existing logic)
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

            const list = sessionQuests.map((q: any) => {
                const statusIcon = q.status === 'COMPLETED' ? '✅' : q.status === 'FAILED' ? '❌' : '🔹';
                const typeIcon = q.type === 'MAJOR' ? '👑' : '📜';
                // Show description snippet if available
                const snippet = q.description ? `\n> *${q.description.substring(0, 100)}${q.description.length > 100 ? '...' : ''}*` : '';
                return `${typeIcon} ${statusIcon} **${q.title}** [${q.status}]${snippet}`;
            }).join('\n');

            const header = `Quest della Sessione \`${sessionId}\``;
            await ctx.message.reply(`**🗺️ ${header}:**\n\n${list}`);
            return;
        }

        // SUBCOMMAND: $quest add <Title>
        if (arg.toLowerCase().startsWith('add ')) {
            const title = arg.substring(4);
            const currentSession = guildSessions.get(ctx.guildId);
            addQuest(ctx.activeCampaign!.id, title, currentSession, undefined, 'OPEN', 'MAJOR', true);

            // Add initial history event?
            if (currentSession) {
                addQuestEvent(ctx.activeCampaign!.id, title, currentSession, "Quest iniziata.", "CREATION", true);
                regenerateQuestBio(ctx.activeCampaign!.id, title, "OPEN"); // Async
            }

            await ctx.message.reply(`🗺️ Quest aggiunta: **${title}**`);
            return;
        }

        // SUBCOMMAND: $quest update <Title> | <Note>
        // Syntax: $quest update Find the Ring | We found a clue
        if (arg.toLowerCase().startsWith('update ')) {
            const content = arg.substring(7);
            const parts = content.split('|');
            if (parts.length < 2) {
                await ctx.message.reply("⚠️ Uso: `$quest update <Titolo/ID> | <Evento/Progresso>`");
                return;
            }
            let title = parts[0].trim();
            const note = parts.slice(1).join('|').trim();

            // ID Resolution
            const idMatch = title.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                // Fetch specific quest by offset
                const active = questRepository.getOpenQuests(ctx.activeCampaign!.id, 1, idx);
                if (active.length > 0) title = active[0].title;
            }

            const quest = getQuestByTitle(ctx.activeCampaign!.id, title);
            if (!quest) {
                await ctx.message.reply(`❌ Quest non trovata: "${title}"`);
                return;
            }

            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addQuestEvent(ctx.activeCampaign!.id, title, currentSession, note, "PROGRESS", true);
            await ctx.message.reply(`📝 Nota aggiunta a **${title}**. Rigenerazione diario...`);

            // Trigger Regen
            await regenerateQuestBio(ctx.activeCampaign!.id, title, quest.status);
            return;
        }

        // SUBCOMMAND: $quest delete <Title or ID>
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            let search = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const idMatch = search.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const active = questRepository.getOpenQuests(ctx.activeCampaign!.id, 1, idx);
                if (active.length > 0) search = active[0].title;
            }

            const quest = getQuestByTitle(ctx.activeCampaign!.id, search);
            if (!quest) {
                await ctx.message.reply(`❌ Quest non trovata: "${search}"`);
                return;
            }

            // Full Wipe
            await ctx.message.reply(`🗑️ Eliminazione completa per **${quest.title}** in corso...`);
            deleteQuestRagSummary(ctx.activeCampaign!.id, quest.title);
            deleteQuestHistory(ctx.activeCampaign!.id, quest.title);
            deleteQuest(quest.id);

            await ctx.message.reply(`✅ Quest **${quest.title}** eliminata definitivamente (RAG, Storia, Database).`);
            return;
        }

        // SUBCOMMAND: $quest done <Title or ID>
        if (arg.toLowerCase().startsWith('done ') || arg.toLowerCase().startsWith('completata ')) {
            let search = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const idMatch = search.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const active = questRepository.getOpenQuests(ctx.activeCampaign!.id, 1, idx);
                if (active.length > 0) search = active[0].title;
            }

            updateQuestStatus(ctx.activeCampaign!.id, search, 'COMPLETED');

            // Add Event
            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            // We need exact title for event. 
            const quest = getQuestByTitle(ctx.activeCampaign!.id, search); // Fuzzy might fail if search is partial
            if (quest) {
                addQuestEvent(ctx.activeCampaign!.id, quest.title, currentSession, "La quest è stata completata con successo.", "COMPLETION", true);
                regenerateQuestBio(ctx.activeCampaign!.id, quest.title, "COMPLETED");
            }

            await ctx.message.reply(`✅ Quest completata: **${search}**`);
            return;
        }

        // SUBCOMMAND: list [page]
        if (arg.toLowerCase().startsWith('list') || arg.toLowerCase().startsWith('lista')) {
            let page = 1;
            const parts = arg.split(' ');
            if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                page = parseInt(parts[1]);
            }

            const pageSize = 10;
            const offset = (page - 1) * pageSize;
            const total = questRepository.countOpenQuests(ctx.activeCampaign!.id);
            const totalPages = Math.ceil(total / pageSize);

            if (page < 1 || (totalPages > 0 && page > totalPages)) {
                await ctx.message.reply(`❌ Pagina ${page} non valida. Totale pagine: ${totalPages || 1}.`);
                return;
            }

            const quests = questRepository.getOpenQuests(ctx.activeCampaign!.id, pageSize, offset);
            if (quests.length === 0) {
                await ctx.message.reply("Nessuna quest attiva al momento.");
                return;
            }

            const list = quests.map((q: any, i: number) => {
                const absoluteIndex = offset + i + 1;
                const typeIcon = q.type === 'MAJOR' ? '👑' : '📜';
                const desc = q.description ? `\n   > *${q.description.substring(0, 150)}${q.description.length > 150 ? '...' : ''}*` : '';
                return `\`${absoluteIndex}\` ${typeIcon} **${q.title}**${desc}`;
            }).join('\n');

            let footer = `\n\n💡 Usa \`$quest update <Titolo> | <Nota>\` per aggiornare.`;
            if (totalPages > 1) footer = `\n\n📄 **Pagina ${page}/${totalPages}** (Usa \`$quest list ${page + 1}\` per la prossima)` + footer;

            await ctx.message.reply(`**🗺️ Quest Attive (${ctx.activeCampaign?.name})**\n\n${list}${footer}`);
            return;
        }

        // VIEW: Show active quests (Page 1)
        if (!arg) {
            const pageSize = 10;
            const quests = questRepository.getOpenQuests(ctx.activeCampaign!.id, pageSize, 0);
            const total = questRepository.countOpenQuests(ctx.activeCampaign!.id);
            const totalPages = Math.ceil(total / pageSize);

            if (quests.length === 0) {
                await ctx.message.reply("Nessuna quest attiva al momento.");
                return;
            }

            const list = quests.map((q: any, i: number) => {
                const typeIcon = q.type === 'MAJOR' ? '👑' : '📜';
                const desc = q.description ? `\n   > *${q.description.substring(0, 150)}${q.description.length > 150 ? '...' : ''}*` : '';
                return `\`${i + 1}\` ${typeIcon} **${q.title}**${desc}`;
            }).join('\n');

            let footer = `\n\n💡 Usa \`$quest update <Titolo> | <Nota>\` per aggiornare.`;
            if (totalPages > 1) footer = `\n\n📄 **Pagina 1/${totalPages}** (Usa \`$quest list 2\` per la prossima)` + footer;

            await ctx.message.reply(`**🗺️ Quest Attive (${ctx.activeCampaign?.name})**\n\n${list}${footer}`);
            return;
        }
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
