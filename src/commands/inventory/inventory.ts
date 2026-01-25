/**
 * $inventario / $inventory / $loot command - Inventory management
 */

import { Command, CommandContext } from '../types';
import {
    addLoot,
    removeLoot,
    getInventory,
    getSessionInventory,
    mergeInventoryItems,
    // New imports
    addInventoryEvent,
    getInventoryItemByName,
    getInventoryHistory,
    deleteInventoryHistory,
    deleteInventoryRagSummary
} from '../../db';
import { guildSessions } from '../../state/sessionState';
import { isSessionId, extractSessionId } from '../../utils/sessionId';
import { generateBio } from '../../bard/bio';

// Helper for Regen
async function regenerateItemBio(campaignId: number, itemName: string) {
    const history = getInventoryHistory(campaignId, itemName);
    const item = getInventoryItemByName(campaignId, itemName);
    const currentDesc = item?.description || "";

    // Map history to simple objects
    const simpleHistory = history.map(h => ({ description: h.description, event_type: h.event_type }));
    await generateBio('ITEM', { campaignId, name: itemName, currentDesc }, simpleHistory);
}

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

            const list = sessionItems.map((i: any) => {
                const desc = i.description ? `\n> *${i.description.substring(0, 100)}${i.description.length > 100 ? '...' : ''}*` : '';
                return `📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}${desc}`;
            }).join('\n');
            await ctx.message.reply(`**💰 Loot della Sessione \`${sessionId}\`:**\n\n${list}`);
            return;
        }

        // SUBCOMMAND: $loot add <Item>
        if (arg.toLowerCase().startsWith('add ')) {
            const item = arg.substring(4).trim();
            const currentSession = guildSessions.get(ctx.guildId);
            addLoot(ctx.activeCampaign!.id, item, 1, currentSession);

            // Add Event
            if (currentSession) {
                addInventoryEvent(ctx.activeCampaign!.id, item, currentSession, "Oggetto acquisito.", "LOOT");
                regenerateItemBio(ctx.activeCampaign!.id, item);
            }

            await ctx.message.reply(`💰 Aggiunto: **${item}**`);
            return;
        }

        // SUBCOMMAND: $loot update <Item> | <Note>
        if (arg.toLowerCase().startsWith('update ')) {
            const content = arg.substring(7);
            const parts = content.split('|');
            if (parts.length < 2) {
                await ctx.message.reply("⚠️ Uso: `$loot update <Oggetto/ID> | <Nota/Storia>`");
                return;
            }
            let item = parts[0].trim();
            const note = parts.slice(1).join('|').trim();

            // ID Resolution
            const idMatch = item.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const all = getInventory(ctx.activeCampaign!.id);
                if (all[idx]) item = all[idx].item_name;
            }

            const existing = getInventoryItemByName(ctx.activeCampaign!.id, item);
            if (!existing) {
                await ctx.message.reply(`❌ Oggetto non trovato: "${item}"`);
                return;
            }

            const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
            addInventoryEvent(ctx.activeCampaign!.id, item, currentSession, note, "MANUAL_UPDATE");
            await ctx.message.reply(`📝 Nota aggiunta a **${item}**. Aggiornamento leggenda...`);

            await regenerateItemBio(ctx.activeCampaign!.id, item);
            return;
        }

        // SUBCOMMAND: $loot use <Item>
        const usePrefixes = ['use ', 'usa ', 'remove '];
        const prefix = usePrefixes.find(p => arg.toLowerCase().startsWith(p));

        if (prefix) {
            let item = arg.substring(prefix.length).trim();

            // ID Resolution
            const idMatch = item.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const all = getInventory(ctx.activeCampaign!.id);
                if (all[idx]) item = all[idx].item_name;
            }
            // We should arguably parse better but sticking to legacy behavior:
            // The split is `arg.split(' ').slice(1).join(' ')` which basically takes everything after "use".

            const removed = removeLoot(ctx.activeCampaign!.id, item, 1);
            if (removed) {
                const currentSession = guildSessions.get(ctx.guildId) || 'UNKNOWN_SESSION';
                addInventoryEvent(ctx.activeCampaign!.id, item, currentSession, "Oggetto utilizzato/rimosso.", "USE");
                regenerateItemBio(ctx.activeCampaign!.id, item);
                await ctx.message.reply(`📉 Rimosso/Usato: **${item}**`);
            }
            else await ctx.message.reply(`⚠️ Oggetto "${item}" non trovato nell'inventario.`);
            return;
            return;
        }

        // SUBCOMMAND: $loot delete <Item> (Full Wipe)
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            let item = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const idMatch = item.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const all = getInventory(ctx.activeCampaign!.id);
                if (all[idx]) item = all[idx].item_name;
            }

            const existing = getInventoryItemByName(ctx.activeCampaign!.id, item);
            if (!existing) {
                await ctx.message.reply(`❌ Oggetto non trovato: "${item}"`);
                return;
            }

            // Full Wipe
            await ctx.message.reply(`🗑️ Eliminazione completa per **${item}** in corso...`);
            deleteInventoryRagSummary(ctx.activeCampaign!.id, item);
            deleteInventoryHistory(ctx.activeCampaign!.id, item);
            // removeLoot can delete if qty matches, but we want force delete. 
            // We'll use removeLoot(all qty) or just directly delete?
            // Existing `removeLoot` deletes if qty is 0. 
            removeLoot(ctx.activeCampaign!.id, item, 999999);

            await ctx.message.reply(`✅ Oggetto **${item}** eliminato definitivamente (RAG, Storia, Inventario).`);
            return;
        }

        // VIEW: Show inventory
        const items = getInventory(ctx.activeCampaign!.id);
        if (items.length === 0) {
            await ctx.message.reply("Lo zaino è vuoto.");
            return;
        }

        const list = items.map((i: any, idx: number) => {
            const desc = i.description ? `\n> *${i.description.substring(0, 100)}${i.description.length > 100 ? '...' : ''}*` : '';
            return `\`${idx + 1}\` 📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}${desc}`;
        }).join('\n');
        await ctx.message.reply(`**💰 Inventario di Gruppo (${ctx.activeCampaign?.name})**\n\n${list}\n\n💡 Usa \`$loot <ID>\` o \`$loot update <ID> | <Nota>\` per interagire.`);
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
