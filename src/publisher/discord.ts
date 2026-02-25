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
    getSessionEncounteredNPCs,
    getNextSessionNumber,
    updateLastSessionNumber
} from '../db';
import { fetchSessionInfoFromHistory, truncate } from './formatters';
import { safeSend } from '../utils/discordHelper';
import { config } from '../config';

// No fallback - each server must configure its own summary channel, or it uses the command channel
const getSummaryChannelId = (guildId: string) => getGuildConfig(guildId, 'summary_channel_id') || null;

export async function publishSummary(
    client: Client,
    sessionId: string,
    log: string[],
    defaultChannel: TextChannel,
    isReplay: boolean = false,
    title?: string,
    loot?: Array<{ name: string; quantity?: number; description?: string }>,
    quests?: Array<{ title: string; description?: string; status?: string }>,
    narrative?: string,
    monsters?: Array<{ name: string; status: string; count?: string }>,
    encounteredNPCs?: Array<{ name: string; role: string | null; status: string; description: string | null }>,
    narrativeBriefs?: string[],
    factionUpdates?: Array<{ name: string; reputation_change?: { value: number; reason: string } }>,
    characterGrowth?: Array<{ name: string; event: string; type: string }>,
    partyAlignmentChange?: { moral_impact?: number; ethical_impact?: number; reason: string },
    artifacts?: Array<{ name: string; status?: string; description?: string }>,
    artifactEvents?: Array<{ name: string; event: string; type: string }>
) {
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

    // 1. Check for manually set session number
    let sessionNum = getExplicitSessionNumber(sessionId);
    if (sessionNum !== null) {
        console.log(`[Publish] Sessione ${sessionId}: Usato numero manuale ${sessionNum}`);
    }

    // 2. If replay, try to find original number from history
    if (sessionNum === null && isReplay && discordSummaryChannel) {
        const info = await fetchSessionInfoFromHistory(discordSummaryChannel, sessionId);
        if (info.sessionNumber) {
            sessionNum = info.sessionNumber;
            setSessionNumber(sessionId, sessionNum);
        }
    }

    // 3. If still null, use intelligent auto-increment from DB
    if (sessionNum === null) {
        const campaignId = getSessionCampaignId(sessionId);
        if (campaignId) {
            sessionNum = getNextSessionNumber(campaignId);
            setSessionNumber(sessionId, sessionNum);
            updateLastSessionNumber(campaignId, sessionNum);
            console.log(`[Publish] Sessione ${sessionId}: Auto-assegnato numero ${sessionNum} per campagna ${campaignId}`);
        } else {
            sessionNum = 1;
            setSessionNumber(sessionId, sessionNum);
        }
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

    // --- RACCONTO NARRATIVO BREVE (uno per atto se multi-part) ---
    const briefs = narrativeBriefs && narrativeBriefs.length > 0 ? narrativeBriefs : (narrative ? [narrative] : []);

    if (briefs.length > 0) {
        const isMultiAct = briefs.length > 1;

        for (let i = 0; i < briefs.length; i++) {
            const brief = briefs[i];
            if (brief && brief.length > 10) {
                const actLabel = isMultiAct ? ` — Atto ${i + 1}` : '';
                await targetChannel.send(`### 📖 Racconto${actLabel}`);
                await safeSend(targetChannel, brief);
            }
        }
        await targetChannel.send(`---`); // Separatore
    }
    // ---------------------------------

    // --- RIASSUNTO EVENTI (LOG) ---
    if (log && log.length > 0) {
        await targetChannel.send(`### 📝 Riassunto Eventi`);
        const logText = log.map(entry => `• ${entry}`).join('\n');
        await safeSend(targetChannel, logText);
    }

    // --- RIEPILOGO TECNICO ---
    // Layout: Bottino e Missioni full-width (testo lungo),
    // tutto il resto inline → griglia automatica fino a 3 colonne per riga
    const embed = new EmbedBuilder()
        .setColor("#F1C40F")
        .setTitle("🎒 Riepilogo Tecnico");

    // --- FULL-WIDTH: sezioni con testo potenzialmente lungo ---
    const lootText = (loot && loot.length > 0) ? loot.map(i => {
        const qtyStr = i.quantity && i.quantity > 1 ? ` (x${i.quantity})` : '';
        return `• ${i.name}${qtyStr}`;
    }).join('\n') : "Nessun bottino recuperato";
    embed.addFields({ name: "💰 Bottino (Loot)", value: truncate(lootText), inline: false });

    const questText = (quests && quests.length > 0) ? quests.map(q => {
        if (typeof q === 'string') return `• ${q}`;
        const statusEmoji = q.status === 'COMPLETED' ? '✅' :
            q.status === 'FAILED' ? '❌' :
                q.status === 'DROPPED' ? '🗑️' : '⚔️';
        return `${statusEmoji} **${q.title}**${q.description ? ` - ${q.description}` : ''}`;
    }).join('\n') : "Nessuna missione attiva";
    embed.addFields({ name: "🗺️ Missioni (Quests)", value: truncate(questText), inline: false });

    // --- GRIGLIA INLINE: campi compatti disposti in colonne da Discord ---

    // 🐉 Mostri
    let monsterText = "*Nessuno*";
    if (monsters && monsters.length > 0) {
        monsterText = monsters.map(monster => {
            const countText = monster.count ? ` (${monster.count})` : '';
            const statusEmoji = monster.status === 'DEFEATED' ? '💀' :
                monster.status === 'FLED' ? '🏃' :
                    monster.status === 'ALIVE' ? '⚔️' : '❓';
            return `${statusEmoji} **${monster.name}**${countText}`;
        }).join('\n');
    }
    embed.addFields({ name: "🐉 Mostri", value: truncate(monsterText, 512) });

    // 👥 NPC
    let npcText = "*Nessuno*";
    if (encounteredNPCs && encounteredNPCs.length > 0) {
        npcText = encounteredNPCs.map(npc => {
            const statusEmoji = npc.status === 'DEAD' ? '💀' :
                npc.status === 'HOSTILE' ? '⚔️' :
                    npc.status === 'FRIENDLY' ? '🤝' :
                        npc.status === 'NEUTRAL' ? '🔷' : '✅';
            const roleText = npc.role ? ` *${npc.role}*` : '';
            return `${statusEmoji} **${npc.name}**${roleText}`;
        }).join('\n');
    }
    embed.addFields({ name: '👥 NPC', value: truncate(npcText, 512) });

    // 🏅 Reputazione (condizionale)
    const reputationUpdates = factionUpdates?.filter(f => f.reputation_change);
    if (reputationUpdates && reputationUpdates.length > 0) {
        const repText = reputationUpdates.map(f => {
            const val = f.reputation_change!.value;
            const sign = val >= 0 ? '+' : '';
            const arrow = val > 0 ? '⬆️' : val < 0 ? '⬇️' : '➡️';
            return `${arrow} **${f.name}**: ${sign}${val}\n*${f.reputation_change!.reason}*`;
        }).join('\n');
        embed.addFields({ name: '🏅 Reputazione', value: truncate(repText, 512) });
    }

    // ⚖️ Allineamento Party (condizionale)
    if (partyAlignmentChange) {
        const moralVal = partyAlignmentChange.moral_impact ?? 0;
        const ethicalVal = partyAlignmentChange.ethical_impact ?? 0;
        const moralSign = moralVal >= 0 ? '+' : '';
        const ethicalSign = ethicalVal >= 0 ? '+' : '';
        const moralArrow = moralVal > 0 ? '⬆️' : moralVal < 0 ? '⬇️' : '➡️';
        const ethicalArrow = ethicalVal > 0 ? '⬆️' : ethicalVal < 0 ? '⬇️' : '➡️';
        const alignText = `${moralArrow} Morale: **${moralSign}${moralVal}**\n${ethicalArrow} Etico: **${ethicalSign}${ethicalVal}**\n*${partyAlignmentChange.reason}*`;
        embed.addFields({ name: '⚖️ Allineamento', value: truncate(alignText, 512) });
    }

    // 🗡️ Artefatti (condizionale)
    const artifactLines: string[] = [];
    if (artifacts && artifacts.length > 0) {
        artifacts.forEach(a => {
            const statusEmoji = a.status === 'DESTROYED' ? '💥' : a.status === 'LOST' ? '❓' : a.status === 'DORMANT' ? '💤' : '✨';
            artifactLines.push(`${statusEmoji} **${a.name}**`);
        });
    }
    if (artifactEvents && artifactEvents.length > 0) {
        artifactEvents.forEach(e => {
            const typeEmoji = e.type === 'DISCOVERY' ? '🔍' : e.type === 'ACTIVATION' ? '⚡' :
                e.type === 'DESTRUCTION' ? '💥' : e.type === 'CURSE' || e.type === 'CURSE_REVEAL' ? '🩸' : '📜';
            artifactLines.push(`${typeEmoji} **${e.name}**: ${e.event}`);
        });
    }
    if (artifactLines.length > 0) {
        embed.addFields({ name: '🗡️ Artefatti', value: truncate(artifactLines.join('\n'), 512) });
    }

    // 🧬 Crescita PG (condizionale)
    if (characterGrowth && characterGrowth.length > 0) {
        const growthText = characterGrowth.map(g => {
            const typeEmoji = g.type === 'TRAUMA' ? '💔' : g.type === 'ACHIEVEMENT' ? '🏆' :
                g.type === 'RELATIONSHIP' ? '🤝' : g.type === 'BACKGROUND' ? '📖' : '🎯';
            return `${typeEmoji} **${g.name}**: ${g.event}`;
        }).join('\n');
        embed.addFields({ name: '🧬 Crescita PG', value: truncate(growthText, 512) });
    }

    await targetChannel.send({ embeds: [embed] });
    // ------------------------------------

    if (targetChannel.id !== defaultChannel.id) {
        await defaultChannel.send(`✅ Riassunto della sessione \`${sessionId}\` inviato in <#${targetChannel.id}>`);
    }

    console.log(`📨 Riassunto inviato per sessione ${sessionId} nel canale ${targetChannel.name}!`);
}
