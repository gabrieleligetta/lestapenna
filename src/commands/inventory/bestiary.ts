/**
 * $bestiario / $bestiary command - Monster bestiary
 */

import { Command, CommandContext } from '../types';
import {
    listAllMonsters,
    mergeMonsters,
    // New imports
    addBestiaryEvent,
    getMonsterByName,
    getBestiaryHistory
} from '../../db';
import { guildSessions } from '../../state/sessionState';
import { generateBio } from '../../bard/bio';

// Helper for Regen
async function regenerateMonsterBio(campaignId: number, monsterName: string) {
    const history = getBestiaryHistory(campaignId, monsterName);
    const monster = getMonsterByName(campaignId, monsterName);
    const currentDesc = monster?.description || "";

    // Map history to simple objects
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('MONSTER', { campaignId, name: monsterName, currentDesc }, simpleHistory);
}

export const bestiaryCommand: Command = {
    name: 'bestiary',
    aliases: ['bestiario', 'mostri', 'monsters'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');

        // SUBCOMMAND: $bestiario update <Name> | <Note>
        if (arg.toLowerCase().startsWith('update ')) {
            const content = arg.substring(7);
            const parts = content.split('|');
            if (parts.length < 2) {
                await ctx.message.reply("⚠️ Uso: `$bestiario update <Mostro/ID> | <Nota/Osservazione>`");
                return;
            }
            let name = parts[0].trim();
            const note = parts.slice(1).join('|').trim();

            // ID Resolution
            const idMatch = name.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const all = listAllMonsters(ctx.activeCampaign!.id);
                if (all[idx]) name = all[idx].name;
            }

            const monster = getMonsterByName(ctx.activeCampaign!.id, name);
            if (!monster) {
                await ctx.message.reply(`❌ Mostro "${name}" non trovato.`);
                return;
            }

            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addBestiaryEvent(ctx.activeCampaign!.id, name, currentSession, note, "MANUAL_UPDATE");
            await ctx.message.reply(`📝 Nota aggiunta a **${name}**. Aggiornamento dossier...`);

            await regenerateMonsterBio(ctx.activeCampaign!.id, name);
            return;
        }

        // SUBCOMMAND: $bestiario merge <old> | <new>
        if (arg.toLowerCase().startsWith('merge ')) {
            const parts = arg.substring(6).split('|').map(s => s.trim());
            if (parts.length !== 2) {
                await ctx.message.reply("Uso: `$bestiario merge <nome vecchio> | <nome nuovo>`");
                return;
            }
            const [oldName, newName] = parts;
            const success = mergeMonsters(ctx.activeCampaign!.id, oldName, newName);
            if (success) {
                await ctx.message.reply(`✅ **Mostro unito!**\n👹 **${oldName}** è stato integrato in **${newName}**`);
                // Trigger regen for new name?
                // Maybe yes, but complicated logic with merged history.
                // For now leave as is.
            } else {
                await ctx.message.reply(`❌ Impossibile unire. Verifica che "${oldName}" esista nel bestiario.`);
            }
            return;
        }

        // VIEW: Show specific monster details (ID or Name)
        if (arg && !arg.includes('|')) {
            let search = arg;

            // ID Resolution
            const idMatch = search.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const all = listAllMonsters(ctx.activeCampaign!.id);
                if (all[idx]) search = all[idx].name;
            }

            const monster = listAllMonsters(ctx.activeCampaign!.id).find((m: any) =>
                m.name.toLowerCase().includes(search.toLowerCase())
            );
            if (!monster) {
                await ctx.message.reply(`❌ Mostro "${arg}" non trovato nel bestiario.`);
                return;
            }

            let details = `**👹 ${monster.name}**\n`;
            details += `**Status:** ${monster.status}\n`;
            if (monster.count) details += `**Numero:** ${monster.count}\n`;
            if (monster.description) details += `\n**Descrizione:** ${monster.description}\n`;

            const abilities = monster.abilities ? JSON.parse(monster.abilities) : [];
            const weaknesses = monster.weaknesses ? JSON.parse(monster.weaknesses) : [];
            const resistances = monster.resistances ? JSON.parse(monster.resistances) : [];

            if (abilities.length > 0) details += `\n⚔️ **Abilità:** ${abilities.join(', ')}\n`;
            if (weaknesses.length > 0) details += `🎯 **Debolezze:** ${weaknesses.join(', ')}\n`;
            if (resistances.length > 0) details += `🛡️ **Resistenze:** ${resistances.join(', ')}\n`;
            if (monster.notes) details += `\n📝 **Note:** ${monster.notes}\n`;

            await ctx.message.reply(`${details}\n\n💡 Usa \`$bestiario update <Nome> | <Nota>\` per aggiungere osservazioni.`);
            return;
        }

        // VIEW: Show all monsters grouped by status
        const monsters = listAllMonsters(ctx.activeCampaign!.id);
        if (monsters.length === 0) {
            await ctx.message.reply("👹 Nessun mostro incontrato in questa campagna.");
            return;
        }

        const defeated = monsters.map((m: any, i: number) => ({ ...m, idx: i + 1 })).filter((m: any) => m.status === 'DEFEATED');
        const alive = monsters.map((m: any, i: number) => ({ ...m, idx: i + 1 })).filter((m: any) => m.status === 'ALIVE');
        const fled = monsters.map((m: any, i: number) => ({ ...m, idx: i + 1 })).filter((m: any) => m.status === 'FLED');

        // Only show top 20 or summary if too many?
        // Current logic shows all. 

        let response = `**👹 Bestiario (${ctx.activeCampaign?.name})**\n\n`;

        if (alive.length > 0) {
            response += `⚔️ **Ancora in Vita:**\n${alive.map((m: any) => `\`${m.idx}\` ${m.name}${m.count ? ` (${m.count})` : ''}`).join('\n')}\n\n`;
        }
        if (defeated.length > 0) {
            response += `💀 **Sconfitti:**\n${defeated.map((m: any) => `\`${m.idx}\` ${m.name}${m.count ? ` (${m.count})` : ''}`).join('\n')}\n\n`;
        }
        if (fled.length > 0) {
            response += `🏃 **Fuggiti:**\n${fled.map((m: any) => `\`${m.idx}\` ${m.name}${m.count ? ` (${m.count})` : ''}`).join('\n')}\n\n`;
        }

        response += `💡 Usa \`$bestiario <ID>\` per dettagli o \`$bestiario update <ID> | <Nota>\`.`;
        await ctx.message.reply(response);
    }
};
