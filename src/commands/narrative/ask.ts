import { TextChannel, DMChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { listNpcs, addChatMessage, getChatHistory } from '../../db';
import { syncNpcDossierIfNeeded, askBard } from '../../bard';

export const askCommand: Command = {
    name: 'ask',
    aliases: ['chiedialbardo'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign } = ctx;
        const question = args.join(' ');
        if (!question) {
            await message.reply("Uso: `$chiedialbardo <Domanda>`");
            return;
        }

        // Fix per TS2339: Controllo se il canale supporta sendTyping
        if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
        }

        try {
            // ✅ NUOVO: Sync lazy prima di query RAG
            // Estrai nomi NPC dalla domanda
            const allNpcs = listNpcs(activeCampaign!.id, 1000);
            const mentionedNpcs = allNpcs.filter(npc =>
                question.toLowerCase().includes(npc.name.toLowerCase())
            );

            for (const npc of mentionedNpcs) {
                await syncNpcDossierIfNeeded(activeCampaign!.id, npc.name, false);
            }

            // GESTIONE MEMORIA PERSISTENTE
            const history = getChatHistory(message.channelId, 6); // Recupera ultimi 6 messaggi (3 scambi)
            const answer = await askBard(activeCampaign!.id, question, history);

            // Salva nel DB
            addChatMessage(message.channelId, 'user', question);
            addChatMessage(message.channelId, 'assistant', answer);

            await message.reply(answer);
        } catch (err) {
            console.error("Errore chiedialbardo:", err);
            await message.reply("Il Bardo ha un vuoto di memoria...");
        }
    }
};
