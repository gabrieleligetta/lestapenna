import { Command, CommandContext } from '../types';
import { isRecordingPaused, pauseRecording, resumeRecording } from '../../services/recorder';
import { getActiveSession } from '../../state/sessionState';
import { t } from '../../i18n';
import { assertCampaignWrite } from '../utils/campaignWrite';

export const pauseCommand: Command = {
    name: 'pause',
    category: 'sessione',
    descriptionKey: 'help.cmd.pause',
    aliases: ['pausa', 'riprendi', 'resume'],
    requiresCampaign: false,

    async execute(ctx: CommandContext): Promise<void> {
        const { message } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();

        // Interrupting somebody else's recording is not a read-only act, so the
        // same table membership `$listen` asks for applies here. The check is
        // conditional on purpose: when no campaign is set there is no table to
        // belong to, and refusing would leave a running recording that nobody
        // is allowed to pause.
        if (ctx.activeCampaign && !await assertCampaignWrite(ctx)) return;

        const sessionId = await getActiveSession(message.guild!.id);
        if (!sessionId) {
            await message.reply(t(ctx.locale, 'session.noActive'));
            return;
        }

        if (commandName === 'pausa' || commandName === 'pause') {
            if (isRecordingPaused(message.guild!.id)) {
                await message.reply(t(ctx.locale, 'session.alreadyPaused'));
                return;
            }

            pauseRecording(message.guild!.id);
            await message.reply(t(ctx.locale, 'session.paused'));
            return;
        }

        if (commandName === 'riprendi' || commandName === 'resume') {
            if (!isRecordingPaused(message.guild!.id)) {
                await message.reply(t(ctx.locale, 'session.alreadyRecording'));
                return;
            }

            resumeRecording(message.guild!.id);
            await message.reply(t(ctx.locale, 'session.resumed'));
            return;
        }
    }
};
