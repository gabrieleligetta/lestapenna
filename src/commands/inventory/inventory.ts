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
import { inventoryRepository } from '../../db/repositories/InventoryRepository';
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
                // Fetch specific item by offset
                const all = getInventory(ctx.activeCampaign!.id, 1, idx);
                if (all.length > 0) item = all[0].item_name;
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
                const all = getInventory(ctx.activeCampaign!.id, 1, idx);
                if (all.length > 0) item = all[0].item_name;
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
        }

        // SUBCOMMAND: $loot delete <Item> (Full Wipe)
        if (arg.toLowerCase().startsWith('delete ') || arg.toLowerCase().startsWith('elimina ')) {
            let item = arg.split(' ').slice(1).join(' ');

            // ID Resolution
            const idMatch = item.match(/^#?(\d+)$/);
            if (idMatch) {
                const idx = parseInt(idMatch[1]) - 1;
                const all = getInventory(ctx.activeCampaign!.id, 1, idx);
                if (all.length > 0) item = all[0].item_name;
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

        // SUBCOMMAND: list [page]
        if (arg.toLowerCase().startsWith('list') || arg.toLowerCase().startsWith('lista')) {
            let page = 1;
            const parts = arg.split(' ');
            if (parts.length > 1 && !isNaN(parseInt(parts[1]))) {
                page = parseInt(parts[1]);
            }

            const pageSize = 20;
            const offset = (page - 1) * pageSize;
            const total = inventoryRepository.countInventory(ctx.activeCampaign!.id);
            const totalPages = Math.ceil(total / pageSize);

            if (page < 1 || (totalPages > 0 && page > totalPages)) {
                await ctx.message.reply(`❌ Pagina ${page} non valida. Totale pagine: ${totalPages || 1}.`);
                return;
            }

            const items = getInventory(ctx.activeCampaign!.id, pageSize, offset);
            if (items.length === 0) {
                await ctx.message.reply("Lo zaino è vuoto.");
                return;
            }

            const list = items.map((i: any, idx: number) => {
                const absoluteIndex = offset + idx + 1;
                const desc = i.description ? `\n> *${i.description.substring(0, 100)}${i.description.length > 100 ? '...' : ''}*` : '';
                return `\`${absoluteIndex}\` 📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}${desc}`;
            }).join('\n');

            let footer = `\n\n💡 Usa \`$loot <ID>\` o \`$loot update <ID> | <Nota>\` per interagire.`;
            if (totalPages > 1) footer = `\n\n📄 **Pagina ${page}/${totalPages}** (Usa \`$loot list ${page + 1}\` per la prossima)` + footer;

            await ctx.message.reply(`**💰 Inventario di Gruppo (${ctx.activeCampaign?.name})**\n\n${list}${footer}`);
            return;
        }

        // VIEW: Show inventory (Page 1)
        if (!arg) {
            const pageSize = 20;
            const items = getInventory(ctx.activeCampaign!.id, pageSize, 0);
            const total = inventoryRepository.countInventory(ctx.activeCampaign!.id);
            const totalPages = Math.ceil(total / pageSize);

            if (items.length === 0) {
                await ctx.message.reply("Lo zaino è vuoto.");
                return;
            }

            const list = items.map((i: any, idx: number) => {
                const desc = i.description ? `\n> *${i.description.substring(0, 100)}${i.description.length > 100 ? '...' : ''}*` : '';
                return `\`${idx + 1}\` 📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}${desc}`;
            }).join('\n');

            let footer = `\n\n💡 Usa \`$loot <ID>\` o \`$loot update <ID> | <Nota>\` per interagire.`;
            if (totalPages > 1) footer = `\n\n📄 **Pagina 1/${totalPages}** (Usa \`$loot list 2\` per la prossima)` + footer;

            await ctx.message.reply(`**💰 Inventario di Gruppo (${ctx.activeCampaign?.name})**\n\n${list}${footer}`);
            return;
        }

        // VIEW SPECIFIC ITEM: $loot <ID> or $loot <Name>
        // If arg is numeric, it's ID. If not, it's name.
        const idMatch = arg.match(/^#?(\d+)$/);
        if (idMatch) {
            const idx = parseInt(idMatch[1]) - 1;
            const items = getInventory(ctx.activeCampaign!.id, 1, idx);
            if (items.length > 0) {
                const i = items[0];
                const desc = i.description ? `\n\n📜 **Descrizione:**\n${i.description}` : '';
                const notes = i.notes ? `\n\n📝 **Note:**\n${i.notes}` : '';
                await ctx.message.reply(`📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}${desc}${notes}`);
            } else {
                await ctx.message.reply(`❌ ID #${idMatch[1]} non valido.`);
            }
            return;
        }

        // Name search
        const item = getInventoryItemByName(ctx.activeCampaign!.id, arg);
        if (item) {
            const desc = item.description ? `\n\n📜 **Descrizione:**\n${item.description}` : '';
            const notes = item.notes ? `\n\n📝 **Note:**\n${item.notes}` : '';
            await ctx.message.reply(`📦 **${item.item_name}** ${item.quantity > 1 ? `(x${item.quantity})` : ''}${desc}${notes}`);
        } else {
            await ctx.message.reply(`❌ Oggetto "${arg}" non trovato.`);
        }
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
