/**
 * $bestiario / $bestiary command - Monster bestiary
 */

import { Command, CommandContext } from '../types';
import { listAllMonsters, mergeMonsters } from '../../db';

export const bestiaryCommand: Command = {
    name: 'bestiary',
    aliases: ['bestiario', 'mostri', 'monsters'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');

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
            } else {
                await ctx.message.reply(`❌ Impossibile unire. Verifica che "${oldName}" esista nel bestiario.`);
            }
            return;
        }

        // VIEW: Show specific monster details
        if (arg && !arg.includes('|')) {
            const monster = listAllMonsters(ctx.activeCampaign!.id).find((m: any) =>
                m.name.toLowerCase().includes(arg.toLowerCase())
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

            await ctx.message.reply(details);
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

        let response = `**👹 Bestiario (${ctx.activeCampaign?.name})**\n\n`;

        if (alive.length > 0) {
            response += `⚔️ **Ancora in Vita:**\n${alive.map((m: any) => `• ${m.name}${m.count ? ` (${m.count})` : ''}`).join('\n')}\n\n`;
        }
        if (defeated.length > 0) {
            response += `💀 **Sconfitti:**\n${defeated.map((m: any) => `• ${m.name}${m.count ? ` (${m.count})` : ''}`).join('\n')}\n\n`;
        }
        if (fled.length > 0) {
            response += `🏃 **Fuggiti:**\n${fled.map((m: any) => `• ${m.name}${m.count ? ` (${m.count})` : ''}`).join('\n')}\n\n`;
        }

        response += `💡 Usa \`$bestiario <nome>\` per dettagli o \`$bestiario merge <v> | <n>\` per unire duplicati.`;
        await ctx.message.reply(response);
    }
};
