/**
 * Publisher - Discord Logic
 */

import { TextChannel, EmbedBuilder, Client } from 'discord.js';
import {
    getExplicitSessionNumber,
    setSessionNumber,
    getSessionAuthor,
    getSessionCampaignId,
    getUserName,
    getSessionStartTime,
    getCampaigns,
    getGuildConfig,
    getSessionEncounteredNPCs
} from '../db';
import { fetchSessionInfoFromHistory, truncate } from './formatters';
import { safeSend } from '../utils/discordHelper';
import { config } from '../config';

const getSummaryChannelId = (guildId: string) => getGuildConfig(guildId, 'summary_channel_id') || config.discord.summaryChannelId;

export async function publishSummary(client: Client, sessionId: string, log: string[], defaultChannel: TextChannel, isReplay: boolean = false, title?: string, loot?: Array<{ name: string; quantity?: number; description?: string }>, quests?: string[], narrative?: string, monsters?: Array<{ name: string; status: string; count?: string }>, encounteredNPCs?: Array<{ name: string; role: string | null; status: string; description: string | null }>) {
    const summaryChannelId = getSummaryChannelId(defaultChannel.guild.id);
    let targetChannel: TextChannel = defaultChannel;
    let discordSummaryChannel: TextChannel | null = null;

    if (summaryChannelId) {
        try {
            const ch = await client.channels.fetch(summaryChannelId);
            if (ch && ch.isTextBased()) {
                discordSummaryChannel = ch as TextChannel;
                targetChannel = discordSummaryChannel;
            }
        } catch (e) {
            console.error("❌ Impossibile recuperare il canale dei riassunti specifico:", e);
        }
    }

    let sessionNum = getExplicitSessionNumber(sessionId);
    if (sessionNum !== null) {
        console.log(`[Publish] Sessione ${sessionId}: Usato numero manuale ${sessionNum}`);
    }

    if (sessionNum === null && discordSummaryChannel) {
        const info = await fetchSessionInfoFromHistory(discordSummaryChannel, sessionId);
        if (isReplay) {
            if (info.sessionNumber) {
                sessionNum = info.sessionNumber;
                setSessionNumber(sessionId, sessionNum);
            }
        } else {
            if (info.lastRealNumber > 0) {
                sessionNum = info.lastRealNumber + 1;
                setSessionNumber(sessionId, sessionNum);
            }
        }
    }

    if (sessionNum === null) {
        sessionNum = 1;
        setSessionNumber(sessionId, sessionNum);
    }

    const authorId = getSessionAuthor(sessionId);
    const campaignId = getSessionCampaignId(sessionId);
    const authorName = authorId && campaignId ? (getUserName(authorId, campaignId) || "Viandante") : "Viandante";
    const sessionStartTime = getSessionStartTime(sessionId);
    const sessionDate = new Date(sessionStartTime || Date.now());

    const dateStr = sessionDate.toLocaleDateString('it-IT');
    const dateShort = sessionDate.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const timeStr = sessionDate.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

    const replayTag = isReplay ? " (REPLAY)" : "";

    // Header con nome campagna se disponibile
    let header = `-SESSIONE ${sessionNum} - ${dateStr}${replayTag}\n[ID: ${sessionId}]`;
    if (campaignId) {
        const campaigns = getCampaigns(defaultChannel.guild.id);
        const campaign = campaigns.find(c => c.id === campaignId);
        if (campaign) {
            header = `--- ${campaign.name.toUpperCase()} ---\n` + header;
        }
    }

    await targetChannel.send(`\`\`\`diff\n${header}\n\`\`\``);

    if (title) {
        await targetChannel.send(`## 📜 ${title}`);
    }

    await targetChannel.send(`**${authorName}** — ${dateShort}, ${timeStr}`);

    // --- RACCONTO NARRATIVO BREVE ---
    if (narrative && narrative.length > 10) {
        await targetChannel.send(`### 📖 Racconto`);
        await safeSend(targetChannel, narrative);
        await targetChannel.send(`---`); // Separatore
    }
    // ---------------------------------

    // --- RIASSUNTO EVENTI (LOG) ---
    if (log && log.length > 0) {
        await targetChannel.send(`### 📝 Riassunto Eventi`);
        const logText = log.map(entry => `• ${entry}`).join('\n');
        await safeSend(targetChannel, logText);
    }

    // --- VISUALIZZAZIONE LOOT & QUEST & MOSTRI & NPC ---
    // Mostriamo sempre il riepilogo tecnico
    const embed = new EmbedBuilder()
        .setColor("#F1C40F")
        .setTitle("🎒 Riepilogo Tecnico");

    const lootText = (loot && loot.length > 0) ? loot.map(i => {
        const qtyStr = i.quantity && i.quantity > 1 ? ` (x${i.quantity})` : '';
        return `• ${i.name}${qtyStr}`;
    }).join('\n') : "Nessun bottino recuperato";
    embed.addFields({ name: "💰 Bottino (Loot)", value: truncate(lootText) });

    const questText = (quests && quests.length > 0) ? quests.map(q => `• ${q}`).join('\n') : "Nessuna missione attiva";
    embed.addFields({ name: "🗺️ Missioni (Quests)", value: truncate(questText) });

    let monsterText = "Nessun mostro combattuto";
    if (monsters && monsters.length > 0) {
        monsterText = monsters.map(monster => {
            const countText = monster.count ? ` (${monster.count})` : '';
            const statusEmoji = monster.status === 'DEFEATED' ? '💀' :
                monster.status === 'FLED' ? '🏃' :
                    monster.status === 'ALIVE' ? '⚔️' : '❓';
            return `${statusEmoji} **${monster.name}**${countText} - \`${monster.status}\``;
        }).join('\n');
    }
    embed.addFields({ name: "🐉 Mostri Combattuti", value: truncate(monsterText) });

    let npcText = "Nessun Npc incontrato";
    if (encounteredNPCs && encounteredNPCs.length > 0) {
        npcText = encounteredNPCs.map(npc => {
            // Emoji in base allo status
            const statusEmoji = npc.status === 'DEAD' ? '💀' :
                npc.status === 'HOSTILE' ? '⚔️' :
                    npc.status === 'FRIENDLY' ? '🤝' :
                        npc.status === 'NEUTRAL' ? '🔷' : '✅';

            // Ruolo (se presente)
            const roleText = npc.role ? ` - *${npc.role}*` : '';

            return `${statusEmoji} **${npc.name}**${roleText}`;
        }).join('\n');
    }
    embed.addFields({ name: '👥 NPC Incontrati', value: truncate(npcText) });

    await targetChannel.send({ embeds: [embed] });
    // ------------------------------------

    if (targetChannel.id !== defaultChannel.id) {
        await defaultChannel.send(`✅ Riassunto della sessione \`${sessionId}\` inviato in <#${targetChannel.id}>`);
    }

    console.log(`📨 Riassunto inviato per sessione ${sessionId} nel canale ${targetChannel.name}!`);
}
