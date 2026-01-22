/**
 * $inventario / $inventory / $loot command - Inventory management
 */

import { Command, CommandContext } from '../types';
import {
    addLoot,
    removeLoot,
    getInventory,
    getSessionInventory,
    mergeInventoryItems
} from '../../db';
import { guildSessions } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';

export const inventoryCommand: Command = {
    name: 'inventory',
    aliases: ['inventario', 'loot', 'bag'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');

        // --- SESSION SPECIFIC: $inventario <session_id> ---
        if (arg && isSessionId(arg)) {
            const sessionId = extractSessionId(arg);
            const sessionItems = getSessionInventory(sessionId);

            if (sessionItems.length === 0) {
                await ctx.message.reply(
                    `💰 Nessun oggetto acquisito nella sessione \`${sessionId}\`.\n` +
                    `*Nota: Solo gli oggetti aggiunti dopo l'aggiornamento vengono tracciati per sessione.*`
                );
                return;
            }

            const list = sessionItems.map((i: any) => `📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}`).join('\n');
            await ctx.message.reply(`**💰 Loot della Sessione \`${sessionId}\`:**\n\n${list}`);
            return;
        }

        // SUBCOMMAND: $loot add <Item>
        if (arg.toLowerCase().startsWith('add ')) {
            const item = arg.substring(4);
            const currentSession = guildSessions.get(ctx.guildId);
            addLoot(ctx.activeCampaign!.id, item, 1, currentSession);
            await ctx.message.reply(`💰 Aggiunto: **${item}**`);
            return;
        }

        // SUBCOMMAND: $loot use <Item>
        if (arg.toLowerCase().startsWith('use ') || arg.toLowerCase().startsWith('usa ') || arg.toLowerCase().startsWith('remove ')) {
            const item = arg.split(' ').slice(1).join(' ');
            const removed = removeLoot(ctx.activeCampaign!.id, item, 1);
            if (removed) await ctx.message.reply(`📉 Rimosso/Usato: **${item}**`);
            else await ctx.message.reply(`⚠️ Oggetto "${item}" non trovato nell'inventario.`);
            return;
        }

        // VIEW: Show inventory
        const items = getInventory(ctx.activeCampaign!.id);
        if (items.length === 0) {
            await ctx.message.reply("Lo zaino è vuoto.");
            return;
        }

        const list = items.map((i: any) => `📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}`).join('\n');
        await ctx.message.reply(`**💰 Inventario di Gruppo (${ctx.activeCampaign?.name})**\n\n${list}`);
    }
};

export const mergeItemCommand: Command = {
    name: 'mergeitem',
    aliases: ['unisciitem', 'mergeitems'],
    requiresCampaign: true,

    async execute(ctx: CommandContext): Promise<void> {
        const arg = ctx.args.join(' ');
        const parts = arg.split('|').map(s => s.trim());

        if (parts.length !== 2) {
            await ctx.message.reply("Uso: `$unisciitem <nome vecchio> | <nome nuovo>`\nEsempio: `$unisciitem Pozione Cura | Pozione di cura`");
            return;
        }

        const [oldName, newName] = parts;
        const success = mergeInventoryItems(ctx.activeCampaign!.id, oldName, newName);
        if (success) {
            await ctx.message.reply(`✅ **Oggetti uniti!**\n💰 **${oldName}** è stato integrato in **${newName}**\nLe quantità sono state sommate.`);
        } else {
            await ctx.message.reply(`❌ Impossibile unire. Verifica che "${oldName}" esista nell'inventario.`);
        }
    }
};
