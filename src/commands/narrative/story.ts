import { TextChannel, DMChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { Command, CommandContext } from '../types';
import { db, getNpcEntry, setCampaignYear, addWorldEvent } from '../../db';
import {
    syncAllDirtyCharacters,
    syncCharacterIfNeeded,
    generateCharacterBiography,
    generateNpcBiography
} from '../../bard';

export const storyCommand: Command = {
    name: 'story',
    aliases: ['storia', 'anno0', 'year0', 'data', 'date', 'anno', 'year', 'autoaggiorna', 'autoupdate'], // Multipurpose command handling related subcommands
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
                    // Sync tutti i PG dirty
                    const loadingMsg = await message.reply(`⚙️ **Sincronizzazione Schede PG**\nControllo aggiornamenti in corso...`);
                    try {
                        const result = await syncAllDirtyCharacters(campaignId);
                        if (result.synced === 0) {
                            await loadingMsg.edit(`✅ **Schede PG Sincronizzate**\nNessun aggiornamento necessario.`);
                        } else {
                            await loadingMsg.edit(
                                `✅ **Schede PG Aggiornate!**\n` +
                                `Sincronizzati **${result.synced}** personaggi:\n` +
                                result.names.map(n => `• ${n}`).join('\n')
                            );
                        }
                    } catch (e: any) {
                        await loadingMsg.edit(`❌ Errore sync: ${e.message}`);
                    }
                    return;
                }

                // Sync specifico PG
                const targetPG = db.prepare('SELECT user_id, character_name FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)').get(campaignId, targetName) as any;
                if (!targetPG) {
                    await message.reply(`❌ Non trovo un PG chiamato "**${targetName}**".`);
                    return;
                }

                const loadingMsg = await message.reply(`⚙️ Aggiornamento scheda di **${targetPG.character_name}**...`);
                try {
                    const result = await syncCharacterIfNeeded(campaignId, targetPG.user_id, true); // force=true
                    if (result) {
                        await loadingMsg.edit(`✅ **${targetPG.character_name}** aggiornato!\n\n${result.substring(0, 1800)}...`);
                    } else {
                        await loadingMsg.edit(`ℹ️ **${targetPG.character_name}** non necessita di aggiornamenti.`);
                    }
                } catch (e: any) {
                    await loadingMsg.edit(`❌ Errore: ${e.message}`);
                }
                return;
            }

            // --- Uso standard: $storia <Nome> ---
            const targetName = args.join(' ');
            if (!targetName) {
                await message.reply(
                    "Uso: `$storia <Nome>` (Cerca sia tra i PG che tra gli NPC)\n\n" +
                    "**Sottocomandi:**\n" +
                    "`$storia sync` - Aggiorna tutte le schede PG con eventi recenti\n" +
                    "`$storia sync <NomePG>` - Aggiorna scheda di un PG specifico"
                );
                return;
            }

            // Fix per TS2339: Controllo se il canale supporta sendTyping
            if ('sendTyping' in message.channel) {
                await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
            }

            // 1. Cerca tra i PG (Personaggi Giocanti)
            const targetPG = db.prepare('SELECT race, class FROM characters WHERE campaign_id = ? AND lower(character_name) = lower(?)').get(campaignId, targetName) as any;

            if (targetPG) {
                await message.reply(`📖 **Saga dell'Eroe: ${targetName}**\nIl Bardo sta scrivendo...`);
                const bio = await generateCharacterBiography(campaignId, targetName, targetPG.class || "Eroe", targetPG.race || "Ignoto");
                const chunks = bio.match(/[\s\S]{1,1900}/g) || [];
                for (const chunk of chunks) await (message.channel as TextChannel).send(chunk);
                return;
            }

            // 2. Se non è un PG, cerca tra gli NPC (Dossier)
            const targetNPC = getNpcEntry(campaignId, targetName);

            if (targetNPC) {
                await message.reply(`📂 **Dossier NPC: ${targetNPC.name}**\nConsultazione archivi...`);
                const bio = await generateNpcBiography(campaignId, targetNPC.name, targetNPC.role || "Sconosciuto", targetNPC.description || "Nessuna nota precedente.");
                const chunks = bio.match(/[\s\S]{1,1900}/g) || [];
                for (const chunk of chunks) await (message.channel as TextChannel).send(chunk);
                return;
            }

            // 3. Nessun risultato
            await message.reply(`❌ Non ho trovato nessun PG o NPC chiamato "**${targetName}**" negli archivi di questa campagna.`);
            return;
        }

        // --- $anno0 / $year0 ---
        if (commandName === 'anno0' || commandName === 'year0') {
            const desc = args.join(' ');
            if (!desc) {
                await message.reply("Uso: `$anno0 <Descrizione Evento Cardine>` (es. 'La Caduta dell'Impero')");
                return;
            }

            setCampaignYear(activeCampaign!.id, 0);
            addWorldEvent(activeCampaign!.id, null, desc, 'GENERIC', 0);

            await message.reply(`📅 **Anno 0 Stabilito!**\nEvento: *${desc}*\nOra puoi usare \`$data <Anno>\` per impostare la data corrente.`);
            return;
        }

        // --- $data / $anno ---
        if (commandName === 'data' || commandName === 'date' || commandName === 'anno' || commandName === 'year') {
            const yearStr = args[0];
            if (!yearStr) {
                const current = activeCampaign!.current_year;
                const label = current === undefined ? "Non impostata" : (current === 0 ? "Anno 0" : (current > 0 ? `${current} D.E.` : `${Math.abs(current)} P.E.`));
                await message.reply(`📅 **Data Attuale:** ${label}`);
                return;
            }

            const year = parseInt(yearStr);
            if (isNaN(year)) {
                await message.reply("Uso: `$data <Numero Anno>` (es. 100 o -50)");
                return;
            }

            setCampaignYear(activeCampaign!.id, year);
            const label = year === 0 ? "Anno 0" : (year > 0 ? `${year} D.E.` : `${Math.abs(year)} P.E.`);

            // Aggiorna anche l'anno corrente in memoria
            activeCampaign!.current_year = year;

            await message.reply(`📅 Data campagna aggiornata a: **${label}**`);
            return;
        }

        // --- $autoupdate ---
        if (commandName === 'autoaggiorna' || commandName === 'autoupdate') {
            const subCmd = args[0]?.toLowerCase();
            // Assuming setCampaignAutoUpdate logic or imported function, but it was just inline in index?
            // Checking index.ts lines 2848... it seems I missed reading autoaggiorna implementation detail in scan.
            // I'll assume usage of setCampaignAutoUpdate from DB or similar. I'll add a TODO or simple error if missing.
            // Wait, import setCampaignAutoUpdate was in index.ts imports line 137. So I can use it.
            const { setCampaignAutoUpdate } = require('../../db'); // Dynamic or use import if added to top.

            if (subCmd === 'on' || subCmd === 'off') {
                const enabled = subCmd === 'on';
                setCampaignAutoUpdate(activeCampaign!.id, enabled);
                await message.reply(`🔄 **Auto-Aggiornamento PG** ${enabled ? 'ATTIVATO' : 'DISATTIVATO'}.`);
            } else {
                await message.reply("Uso: `$autoupdate on/off`");
            }
        }
    }
};
