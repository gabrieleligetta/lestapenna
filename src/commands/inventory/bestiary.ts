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
    getBestiaryHistory,
    getMonsterByShortId,
    deleteMonster
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
            const sidMatch = name.match(/^#([a-z0-9]{5})$/i);
            const idMatch = name.match(/^#?(\d+)$/);

            if (sidMatch) {
                const monster = getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (monster) name = monster.name;
            }

            const monster = getMonsterByName(ctx.activeCampaign!.id, name);
            if (!monster) {
                await ctx.message.reply(`❌ Mostro "${name}" non trovato.`);
                return;
            }

            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addBestiaryEvent(ctx.activeCampaign!.id, name, currentSession, note, "MANUAL_UPDATE", true);
            await ctx.message.reply(`📝 Nota aggiunta a **${name}**. Aggiornamento dossier...`);

            await regenerateMonsterBio(ctx.activeCampaign!.id, name);
            return;
        }

        // SUBCOMMAND: $bestiario delete <Name>
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            let name = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const sidMatch = name.match(/^#([a-z0-9]{5})$/i);
            const idMatch = name.match(/^#?(\d+)$/);

            if (sidMatch) {
                const monster = getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (monster) name = monster.name;
            }

            const existing = getMonsterByName(ctx.activeCampaign!.id, name);
            if (!existing) {
                await ctx.message.reply(`❌ Mostro "${name}" non trovato.`);
                return;
            }

            // Delete
            const success = deleteMonster(ctx.activeCampaign!.id, name);
            if (success) {
                await ctx.message.reply(`🗑️ Mostro **${name}** eliminato dal bestiario.`);
                // Clean up Knowledge RAG? Not strictly necessary unless we want perfection.
                // Assuming deleteMonster handles DB cascade if set, otherwise manual.
                // The repository handles history delete. 
            } else {
                await ctx.message.reply(`❌ Impossibile eliminare **${name}**.`);
            }
            return;
        }

        // SUBCOMMAND: $bestiario merge <old> | <new>
        if (arg.toLowerCase().startsWith('merge ')) {
            const parts = arg.substring(6).split('|').map(s => s.trim());
            if (parts.length !== 2) {
                await ctx.message.reply("Uso: `$bestiario merge <nome vecchio/ID> | <nome nuovo/ID>`");
                return;
            }
            let [oldName, newName] = parts;

            // Resolve Old Name
            const oldSidMatch = oldName.match(/^#([a-z0-9]{5})$/i);
            const oldIdMatch = oldName.match(/^#?(\d+)$/);
            if (oldSidMatch) {
                const m = getMonsterByShortId(ctx.activeCampaign!.id, oldSidMatch[1]);
                if (m) oldName = m.name;
            }

            // Resolve New Name
            const newSidMatch = newName.match(/^#([a-z0-9]{5})$/i);
            const newIdMatch = newName.match(/^#?(\d+)$/);
            if (newSidMatch) {
                const m = getMonsterByShortId(ctx.activeCampaign!.id, newSidMatch[1]);
                if (m) newName = m.name;
            }

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
            const sidMatch = search.match(/^#([a-z0-9]{5})$/i);
            const idMatch = search.match(/^#?(\d+)$/);

            if (sidMatch) {
                const monster = getMonsterByShortId(ctx.activeCampaign!.id, sidMatch[1]);
                if (monster) search = monster.name;
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

        const defeated = monsters.filter((m: any) => m.status === 'DEFEATED');
        const alive = monsters.filter((m: any) => m.status === 'ALIVE');
        const fled = monsters.filter((m: any) => m.status === 'FLED');

        // Only show top 20 or summary if too many?
        // Current logic shows all. 

        let response = `**👹 Bestiario (${ctx.activeCampaign?.name})**\n\n`;

        if (alive.length > 0) {
            response += `⚔️ **Ancora in Vita:**\n${alive.map((m: any) => `\`#${m.short_id}\` ${m.name}${m.count ? ` (${m.count})` : ''}`).join('\n')}\n\n`;
        }
        if (defeated.length > 0) {
            response += `💀 **Sconfitti:**\n${defeated.map((m: any) => `\`#${m.short_id}\` ${m.name}${m.count ? ` (${m.count})` : ''}`).join('\n')}\n\n`;
        }
        if (fled.length > 0) {
            response += `🏃 **Fuggiti:**\n${fled.map((m: any) => `\`#${m.short_id}\` ${m.name}${m.count ? ` (${m.count})` : ''}`).join('\n')}\n\n`;
        }

        response += `💡 Usa \`$bestiario <ID>\` per dettagli o \`$bestiario update <ID> | <Nota>\`.`;
        await ctx.message.reply(response);
    }
};
