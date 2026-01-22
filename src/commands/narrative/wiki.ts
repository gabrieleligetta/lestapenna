import { TextChannel, DMChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { searchKnowledge } from '../../bard'; // searchKnowledge was not in destructuring in index.ts but imported via require? Line 2678: require('./bard')

export const wikiCommand: Command = {
    name: 'wiki',
    aliases: ['lore'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign } = ctx;
        const term = args.join(' ');
        if (!term) {
            await message.reply("Uso: `$wiki <Termine>`");
            return;
        }

        // Fix per TS2339: Controllo se il canale supporta sendTyping
        if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
        }

        try {
            // Usa searchKnowledge ma restituisce i risultati raw
            // In index.ts logic it used dynamic require: const { searchKnowledge } = require('./bard');
            // Here we imported it statically.
            const fragments = await searchKnowledge(activeCampaign!.id, term, 3);

            if (fragments.length === 0) {
                await message.reply("Non ho trovato nulla negli archivi su questo argomento.");
                return;
            }

            // Limite embed Discord: 4096 caratteri per description
            const MAX_DESC_LENGTH = 4000; // Buffer di sicurezza
            const MAX_FRAGMENT_LENGTH = 1200; // Max per singolo frammento

            // Tronca ogni frammento se troppo lungo
            const truncatedFragments = fragments.map((f: string) => {
                if (f.length > MAX_FRAGMENT_LENGTH) {
                    return f.substring(0, MAX_FRAGMENT_LENGTH) + '... [troncato]';
                }
                return f;
            });

            // Costruisci descrizione con controllo lunghezza
            let description = '';
            for (let i = 0; i < truncatedFragments.length; i++) {
                const fragmentText = `**Frammento ${i + 1}:**\n${truncatedFragments[i]}`;
                if ((description.length + fragmentText.length + 2) < MAX_DESC_LENGTH) {
                    description += fragmentText + '\n\n';
                } else {
                    break;
                }
            }

            await message.reply(`📜 **Risultati Archivio: "${term}"**\n\n${description}`);

        } catch (err) {
            console.error("Errore wiki:", err);
            await message.reply("Errore nella consultazione degli archivi.");
        }
    }
};
