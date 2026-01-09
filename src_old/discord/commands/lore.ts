import { Message, EmbedBuilder, TextChannel, DMChannel, NewsChannel, ThreadChannel } from 'discord.js';
import { getActiveCampaign, listNpcs, updateNpcEntry, getNpcEntry, db, addQuest, updateQuestStatus, getOpenQuests, addLoot, removeLoot, getInventory, setCampaignYear, addWorldEvent, getWorldTimeline, getChatHistory, addChatMessage } from '../../db';
import { askBard, searchKnowledge } from '../../bard';
import { guildSessions } from '../state';

export async function handleLoreCommands(message: Message, command: string, args: string[]) {
    const activeCampaign = getActiveCampaign(message.guild!.id);
    if (!activeCampaign) return;

    // --- NPC ---
    if (command === 'npc' || command === 'dossier') {
        const argsStr = args.join(' ');

        if (!argsStr) {
            const npcs = listNpcs(activeCampaign.id);
            if (npcs.length === 0) return message.reply("L'archivio NPC è vuoto.");

            const list = npcs.map((n: any) => `👤 **${n.name}** (${n.role || '?'}) [${n.status}]`).join('\n');
            return message.reply(`**📂 Dossier NPC Recenti**\n${list}`);
        }

        if (argsStr.includes('|')) {
            const [name, desc] = argsStr.split('|').map(s => s.trim());
            updateNpcEntry(activeCampaign.id, name, desc);
            return message.reply(`👤 Scheda di **${name}** aggiornata.`);
        } else {
            const npc = getNpcEntry(activeCampaign.id, argsStr);
            if (!npc) return message.reply("NPC non trovato.");

            const embed = new EmbedBuilder()
                .setTitle(`👤 Dossier: ${npc.name}`)
                .setColor(npc.status === 'DEAD' ? "#FF0000" : "#00FF00")
                .addFields(
                    { name: "Ruolo", value: npc.role || "Sconosciuto", inline: true },
                    { name: "Stato", value: npc.status || "Vivo", inline: true },
                    { name: "Note", value: npc.description || "Nessuna nota." }
                )
                .setFooter({ text: `Ultimo avvistamento: ${npc.last_updated}` });

            return message.reply({ embeds: [embed] });
        }
    }

    // --- PRESENZE ---
    if (command === 'presenze') {
        const sessionId = guildSessions.get(message.guild!.id);
        if (!sessionId) return await message.reply("⚠️ Nessuna sessione attiva.");

        // Recupera tutti gli NPC univoci visti nelle registrazioni della sessione
        const rows = db.prepare(`
            SELECT DISTINCT present_npcs 
            FROM recordings 
            WHERE session_id = ? AND present_npcs IS NOT NULL
        `).all(sessionId) as { present_npcs: string }[];

        // Unisci e pulisci le stringhe (es. "Grog,Mario" e "Mario,Luigi")
        const allNpcs = new Set<string>();
        rows.forEach(r => r.present_npcs.split(',').forEach(n => {
            const trimmed = n.trim();
            if (trimmed) allNpcs.add(trimmed);
        }));

        if (allNpcs.size === 0) {
            return message.reply(`👥 **NPC Incontrati:** Nessuno rilevato finora.`);
        }

        return message.reply(`👥 **NPC Incontrati in questa sessione:**\n${Array.from(allNpcs).join(', ')}`);
    }

    // --- QUEST ---
    if (command === 'quest' || command === 'obiettivi') {
        const arg = args.join(' ');

        if (arg.toLowerCase().startsWith('add ')) {
            const title = arg.substring(4);
            addQuest(activeCampaign.id, title);
            return message.reply(`🗺️ Quest aggiunta: **${title}**`);
        }
        if (arg.toLowerCase().startsWith('done ') || arg.toLowerCase().startsWith('completata ')) {
            const search = arg.split(' ').slice(1).join(' ');
            updateQuestStatus(activeCampaign.id, search, 'COMPLETED');
            return message.reply(`✅ Quest aggiornata come completata (ricerca: "${search}")`);
        }

        const quests = getOpenQuests(activeCampaign.id);
        if (quests.length === 0) return message.reply("Nessuna quest attiva al momento.");

        const list = quests.map((q: any) => `🔹 **${q.title}**`).join('\n');
        return message.reply(`**🗺️ Quest Attive (${activeCampaign.name})**\n\n${list}`);
    }

    // --- INVENTARIO ---
    if (command === 'inventario' || command === 'loot' || command === 'bag' || command === 'inventory') {
        const arg = args.join(' ');

        if (arg.toLowerCase().startsWith('add ')) {
            const item = arg.substring(4);
            addLoot(activeCampaign.id, item, 1);
            return message.reply(`💰 Aggiunto: **${item}**`);
        }
        if (arg.toLowerCase().startsWith('use ') || arg.toLowerCase().startsWith('usa ') || arg.toLowerCase().startsWith('remove ')) {
            const item = arg.split(' ').slice(1).join(' ');
            const removed = removeLoot(activeCampaign.id, item, 1);
            if (removed) return message.reply(`📉 Rimosso/Usato: **${item}**`);
            else return message.reply(`⚠️ Oggetto "${item}" non trovato nell'inventario.`);
        }

        const items = getInventory(activeCampaign.id);
        if (items.length === 0) return message.reply("Lo zaino è vuoto.");

        const list = items.map((i: any) => `📦 **${i.item_name}** ${i.quantity > 1 ? `(x${i.quantity})` : ''}`).join('\n');
        return message.reply(`**💰 Inventario di Gruppo (${activeCampaign.name})**\n\n${list}`);
    }

    // --- ANNO 0 ---
    if (command === 'anno0' || command === 'year0') {
        const desc = args.join(' ');
        if (!desc) return await message.reply("Uso: `$anno0 <Descrizione Evento Cardine>` (es. 'La Caduta dell'Impero')");

        setCampaignYear(activeCampaign.id, 0);
        addWorldEvent(activeCampaign.id, null, desc, 'GENERIC', 0);

        return await message.reply(`📅 **Anno 0 Stabilito!**\nEvento: *${desc}*\nOra puoi usare \`$data <Anno>\` per impostare la data corrente.`);
    }

    // --- DATA ---
    if (command === 'data' || command === 'date' || command === 'anno' || command === 'year') {
        const yearStr = args[0];
        if (!yearStr) {
            const current = activeCampaign.current_year;
            const label = current === undefined ? "Non impostata" : (current === 0 ? "Anno 0" : (current > 0 ? `${current} D.E.` : `${Math.abs(current)} P.E.`));
            return await message.reply(`📅 **Data Attuale:** ${label}`);
        }

        const year = parseInt(yearStr);
        if (isNaN(year)) return await message.reply("Uso: `$data <Numero Anno>` (es. 100 o -50)");

        setCampaignYear(activeCampaign.id, year);
        const label = year === 0 ? "Anno 0" : (year > 0 ? `${year} D.E.` : `${Math.abs(year)} P.E.`);
        
        activeCampaign.current_year = year; // Aggiorna ref locale
        
        return await message.reply(`📅 Data campagna aggiornata a: **${label}**`);
    }

    // --- TIMELINE ---
    if (command === 'timeline' || command === 'cronologia') {
        const arg = args.join(' ');

        if (arg.toLowerCase().startsWith('add ')) {
            const parts = arg.substring(4).split('|').map(s => s.trim());
            if (parts.length < 3) return await message.reply("Uso: `$timeline add <Anno> | <Tipo> | <Descrizione>`\nEs: `$timeline add -500 | WAR | Guerra Antica`");

            const year = parseInt(parts[0]);
            const type = parts[1].toUpperCase();
            const desc = parts[2];

            if (isNaN(year)) return await message.reply("L'anno deve essere un numero.");

            addWorldEvent(activeCampaign.id, null, desc, type, year);
            return await message.reply(`📜 Evento storico aggiunto nell'anno **${year}**.`);
        }

        const events = getWorldTimeline(activeCampaign.id);

        if (events.length === 0) {
            return await message.reply("📜 La cronologia mondiale è ancora bianca. Nessun grande evento registrato.");
        }

        let msg = `🌍 **Cronologia del Mondo: ${activeCampaign.name}**\n\n`;

        const icons: Record<string, string> = {
            'WAR': '⚔️',
            'POLITICS': '👑',
            'DISCOVERY': '💎',
            'CALAMITY': '🌋',
            'SUPERNATURAL': '🔮',
            'GENERIC': '🔹'
        };

        events.forEach((e: any) => {
            const icon = icons[e.event_type] || '🔹';
            const yearLabel = e.year === 0 ? "**[Anno 0]**" : (e.year > 0 ? `**[${e.year} D.E.]**` : `**[${Math.abs(e.year)} P.E.]**`);
            msg += `${yearLabel} ${icon} ${e.description}\n`;
        });

        const chunks = msg.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of chunks) {
            await (message.channel as TextChannel).send(chunk);
        }
        return;
    }

    // --- CHIEDI AL BARDO ---
    if (command === 'chiedialbardo' || command === 'ask') {
        const question = args.join(' ');
        if (!question) return await message.reply("Uso: `$chiedialbardo <Domanda>`");

        if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
        }

        try {
            const history = getChatHistory(message.channelId, 6);
            const answer = await askBard(activeCampaign.id, question, history);

            addChatMessage(message.channelId, 'user', question);
            addChatMessage(message.channelId, 'assistant', answer);

            await message.reply(answer);
        } catch (err) {
            console.error("Errore chiedialbardo:", err);
            await message.reply("Il Bardo ha un vuoto di memoria...");
        }
        return;
    }

    // --- WIKI ---
    if (command === 'wiki' || command === 'lore') {
        const term = args.join(' ');
        if (!term) return await message.reply("Uso: `$wiki <Termine>`");

        if ('sendTyping' in message.channel) {
            await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).sendTyping();
        }

        try {
            const fragments = await searchKnowledge(activeCampaign.id, term, 3);

            if (fragments.length === 0) {
                return await message.reply("Non ho trovato nulla negli archivi su questo argomento.");
            }

            await message.reply(`📚 **Archivi: ${term}**\nHo trovato ${fragments.length} frammenti pertinenti.`);

            for (let i = 0; i < fragments.length; i++) {
                const fragment = fragments[i];
                const safeFragment = fragment.length > 4000 ? fragment.substring(0, 4000) + "..." : fragment;

                const embed = new EmbedBuilder()
                    .setTitle(`Frammento ${i + 1}`)
                    .setColor("#F1C40F")
                    .setDescription(safeFragment);

                await (message.channel as TextChannel | DMChannel | NewsChannel | ThreadChannel).send({ embeds: [embed] });
            }

        } catch (err) {
            console.error("Errore wiki:", err);
            await message.reply("Errore durante la consultazione degli archivi.");
        }
        return;
    }
}
