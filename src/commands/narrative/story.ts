import { TextChannel, DMChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { db, getNpcEntry, getNpcByShortId } from '../../db';
import {
    syncAllDirtyCharacters,
    syncCharacterIfNeeded,
    generateCharacterBiography,
    generateNpcBiography
} from '../../bard';
import { safeSend } from '../../utils/discordHelper';
import { t, getCampaignLocale } from '../../i18n';

export const storyCommand: Command = {
    name: 'story',
    category: 'personaggi',
    descriptionKey: 'help.cmd.story',
    // Only the aliases this command actually answers to. It used to claim
    // anno0/year0/data/date/anno/year/autoaggiorna/autoupdate as well, all of
    // them shadowed at registration by dateCommand, year0Command and
    // autoupdateCommand — the branches below were unreachable code pretending
    // to be a multipurpose command.
    aliases: ['storia'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const { message, args, activeCampaign, client } = ctx;
        const commandName = message.content.slice(1).split(' ')[0].toLowerCase();

        // --- $storia logic ---
        if (commandName === 'storia' || commandName === 'story') {
            const campaignId = activeCampaign!.id;
            const firstArg = args[0]?.toLowerCase();

            // --- Sottocomando: $storia sync [NomePG] ---
            if (firstArg === 'sync') {
                const targetName = args.slice(1).join(' ');

                if (!targetName) {
                    // Sync every dirty PC
                    const loadingMsg = await message.reply(t(ctx.locale, 'narrative.syncPgStarted'));
                    try {
                        const result = await syncAllDirtyCharacters(campaignId);
                        if (result.synced === 0) {
                            await loadingMsg.edit(t(ctx.locale, 'narrative.syncPgNoUpdate'));
                        } else {
                            await loadingMsg.edit(t(ctx.locale, 'narrative.syncPgDone', {
                                count: result.synced,
                                list: result.names.map(n => `• ${n}`).join('\n')
                            }));
                        }
                    } catch (e: any) {
                        await loadingMsg.edit(t(ctx.locale, 'narrative.syncError', { error: e.message }));
                    }
                    return;
                }

                // Sync specifico PG
                const targetPG = db.prepare('SELECT user_id, character_name FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)').get(campaignId, targetName) as any;
                if (!targetPG) {
                    await message.reply(t(ctx.locale, 'narrative.pgNotFound', { name: targetName }));
                    return;
                }

                const loadingMsg = await message.reply(t(ctx.locale, 'narrative.updatingSheet', { name: targetPG.character_name }));
                try {
                    const result = await syncCharacterIfNeeded(campaignId, targetPG.user_id, true); // force=true
                    if (result) {
                        await loadingMsg.edit(t(ctx.locale, 'narrative.sheetUpdated', { name: targetPG.character_name, content: result.substring(0, 1800) }));
                    } else {
                        await loadingMsg.edit(t(ctx.locale, 'narrative.sheetNoUpdate', { name: targetPG.character_name }));
                    }
                } catch (e: any) {
                    await loadingMsg.edit(t(ctx.locale, 'narrative.genericError', { error: e.message }));
                }
                return;
            }

            // --- Uso standard: $storia <Nome> ---
            const targetName = args.join(' ');
            if (!targetName) {
                await message.reply(t(ctx.locale, 'narrative.storyUsage'));
                return;
            }

            // Works around TS2339: check whether the channel supports sendTyping
            if ('sendTyping' in message.channel) {
                await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
            }

            // 1. Cerca tra i PG (Personaggi Giocanti)
            const targetPG = db.prepare('SELECT race, class FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)').get(campaignId, targetName) as any;

            if (targetPG) {
                await message.reply(t(ctx.locale, 'narrative.heroSaga', { name: targetName }));
                const cLocale = getCampaignLocale(campaignId);
                const bio = await generateCharacterBiography(campaignId, targetName, targetPG.class || t(cLocale, 'narrative.defaultClass'), targetPG.race || t(cLocale, 'narrative.unknownRace'));
                await safeSend(message.channel as TextChannel, bio);
                return;
            }

            // 2. If it is not a PC, look among the NPCs (dossiers)
            let targetNPC = getNpcEntry(campaignId, targetName);

            // SID Lookup
            if (!targetNPC) {
                const sidMatch = targetName.match(/^#([a-z0-9]{5})$/i);
                if (sidMatch) {
                    const result = getNpcByShortId(campaignId, sidMatch[1]);
                    if (result) targetNPC = result;
                }
            }

            if (targetNPC) {
                await message.reply(t(ctx.locale, 'narrative.npcDossier', { name: targetNPC.name }));
                const cLocale = getCampaignLocale(campaignId);
                const bio = await generateNpcBiography(campaignId, targetNPC.name, targetNPC.role || t(cLocale, 'narrative.unknownRole'), targetNPC.description || t(cLocale, 'narrative.noPreviousNotes'));
                await safeSend(message.channel as TextChannel, bio);
                return;
            }

            // 3. No result
            await message.reply(t(ctx.locale, 'narrative.pgNpcNotFound', { name: targetName }));
            return;
        }

    }
};
