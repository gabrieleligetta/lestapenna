import { Command, CommandContext } from '../types';
import { addSessionNote } from '../../db';
// @ts-ignore
import { guildSessions } from '../../index';

export const noteCommand: Command = {
    name: 'note',
    aliases: ['nota'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args } = ctx;
        const sessionId = guildSessions.get(message.guild!.id);

        if (!sessionId) {
            await message.reply("⚠️ Nessuna sessione attiva. Avvia prima una sessione con `$ascolta`.");
            return;
        }

        const noteContent = args.join(' ');
        if (!noteContent) {
            await message.reply("Uso: `$nota <Testo della nota>`");
            return;
        }

        addSessionNote(sessionId, message.author.id, noteContent, Date.now());
        await message.reply("📝 Nota aggiunta al diario della sessione.");
    }
};
