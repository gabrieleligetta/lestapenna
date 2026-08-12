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
    updateLastSessionNumber,
    getAudioMixWarning
} from '../db';
import { fetchSessionInfoFromHistory, truncate } from './formatters';
import { safeSend } from '../utils/discordHelper';
import { config } from '../config';
import { t, getCampaignLocale, getGuildLocale, dateLocale } from '../i18n';

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
    loot_removed?: Array<{ name: string; quantity?: number; description?: string }>,
    quests?: Array<{ title: string; description?: string; status?: string }>,
    narrativeBrief?: string,
    monsters?: Array<{ name: string; status: string }>,
    encounteredNPCs?: Array<{ name: string; role: string | null; status: string; description: string | null }>,
    factionUpdates?: Array<{ name: string; reputation_change?: { value: number; reason: string } }>,
    characterGrowth?: Array<{ name: string; event: string; type: string }>,
    partyAlignmentChange?: { moral_impact?: number; ethical_impact?: number; reason: string },
    artifacts?: Array<{ name: string; status?: string; description?: string }>,
    artifactEvents?: Array<{ name: string; event: string; type: string }>,
    npcEvents?: Array<{ name: string; event: string; type: string }>,
    worldEvents?: Array<{ event: string; type: string }>
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
    // Published content = the table's language (campaign); falls back to the guild's.
    const locale = campaignId ? getCampaignLocale(campaignId) : getGuildLocale(defaultChannel.guild.id);
    const authorName = (authorId && campaignId ? getUserName(authorId, campaignId) : null) || t(locale, 'publish.wanderer');
    const sessionStartTime = getSessionStartTime(sessionId);
    const sessionDate = new Date(sessionStartTime || Date.now());

    const dLocale = dateLocale(locale);
    const dateStr = sessionDate.toLocaleDateString(dLocale);
    const dateShort = sessionDate.toLocaleDateString(dLocale, { day: '2-digit', month: '2-digit', year: '2-digit' });
    const timeStr = sessionDate.toLocaleTimeString(dLocale, { hour: '2-digit', minute: '2-digit' });

    const replayTag = isReplay ? " (REPLAY)" : "";

    // Header with the campaign name when available. The localized session word is
    // re-parsed by fetchSessionInfoFromHistory (formatters.ts): keep them in sync.
    let header = `-${t(locale, 'publish.sessionHeader')} ${sessionNum} - ${dateStr}${replayTag}\n[ID: ${sessionId}]`;
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

    // --- SHORT NARRATIVE RECAP ---
    // A single text (any split into acts has already been reabsorbed
    // upstream), broken into messages only for the Discord limit (safeSend).
    if (narrativeBrief && narrativeBrief.length > 10) {
        await targetChannel.send(t(locale, 'publish.story'));
        await safeSend(targetChannel, narrativeBrief);
        await targetChannel.send(`---`); // Separatore
    }
    // ---------------------------------

    // --- EVENT SUMMARY (LOG) ---
    if (log && log.length > 0) {
        await targetChannel.send(t(locale, 'publish.eventLog'));
        const logText = log.map(entry => `• ${entry}`).join('\n');
        await safeSend(targetChannel, logText);
    }

    // --- EMBED 1: the session's core ---
    const embed1 = new EmbedBuilder()
        .setColor("#F1C40F")
        .setTitle(t(locale, 'publish.techRecapTitle'));

    const lootText = (loot && loot.length > 0) ? loot.map(i => {
        const qtyStr = i.quantity && i.quantity > 1 ? ` (x${i.quantity})` : '';
        const descStr = i.description ? ` — *${i.description}*` : '';
        return `• ${i.name}${qtyStr}${descStr}`;
    }).join('\n') : t(locale, 'publish.noLoot');
    embed1.addFields({ name: t(locale, 'publish.lootField'), value: truncate(lootText) });

    if (loot_removed && loot_removed.length > 0) {
        const lootRemovedText = loot_removed.map(i => {
            const qtyStr = i.quantity && i.quantity > 1 ? ` (x${i.quantity})` : '';
            const descStr = i.description ? ` — *${i.description}*` : '';
            return `• ${i.name}${qtyStr}${descStr}`;
        }).join('\n');
        embed1.addFields({ name: t(locale, 'publish.lootRemovedField'), value: truncate(lootRemovedText) });
    }

    const questText = (quests && quests.length > 0) ? quests.map(q => {
        if (typeof q === 'string') return `• ${q}`;
        const statusEmoji = q.status === 'COMPLETED' ? '✅' :
            q.status === 'FAILED' ? '❌' :
                q.status === 'DROPPED' ? '🗑️' : '⚔️';
        return `${statusEmoji} **${q.title}**${q.description ? ` - ${q.description}` : ''}`;
    }).join('\n') : t(locale, 'publish.noQuests');
    embed1.addFields({ name: t(locale, 'publish.questsField'), value: truncate(questText) });

    let monsterText = t(locale, 'publish.none');
    if (monsters && monsters.length > 0) {
        monsterText = monsters.map(monster => {
            const statusEmoji = monster.status === 'DEFEATED' ? '💀' :
                monster.status === 'FLED' ? '🏃' :
                    monster.status === 'ALIVE' ? '⚔️' : '❓';
            return `${statusEmoji} **${monster.name}**`;
        }).join('\n');
    }
    embed1.addFields({ name: t(locale, 'publish.monstersField'), value: truncate(monsterText) });

    let npcText = t(locale, 'publish.none');
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
    embed1.addFields({ name: t(locale, 'publish.npcsField'), value: truncate(npcText) });

    // 🆕 If the mix lost audio (missing/corrupt files, failed stems), say so here instead
    // of leaving it only in the server logs — see sessionMixer.ts.
    const audioMixWarning = getAudioMixWarning(sessionId);
    if (audioMixWarning && audioMixWarning.length > 0) {
        const reasonLabel: Record<string, string> = {
            missing: t(locale, 'publish.audioReasonMissing'),
            corrupt: t(locale, 'publish.audioReasonCorrupt'),
            stem_failed: t(locale, 'publish.audioReasonStemFailed')
        };
        const warningText = audioMixWarning
            .map(f => `• ${f.filename} (${reasonLabel[f.reason] || f.reason})`)
            .join('\n');
        embed1.addFields({ name: t(locale, 'publish.audioIncompleteField'), value: truncate(warningText) });
    }

    // The CTA lives here, on the recap, and not only on `$stop`: a session can
    // also end through the auto-leave (bootstrap/voiceState.ts) or the hard cap
    // (services/sessionHardCap.ts), and a nudge attached to the command would
    // simply miss those. This footer is on the one message every path produces —
    // and it arrives when the bot has just delivered something, which is the
    // only moment asking is fair.
    // COMMUNITY_NUDGES=false silences this too: «no message volunteers it» has
    // to mean every message, or the setting is a half-promise.
    if (config.links.nudgesEnabled && config.links.webAppUrl) {
        embed1.setFooter({
            text: t(locale, 'community.summaryFooter', { url: config.links.webAppUrl }),
        });
    }

    await targetChannel.send({ embeds: [embed1] });

    // --- EMBED 2: developments (only if there is at least one field) ---
    const embed2 = new EmbedBuilder()
        .setColor("#9B59B6")
        .setTitle(t(locale, 'publish.developmentsTitle'));

    let embed2HasFields = false;

    const reputationUpdates = factionUpdates?.filter(f => f.reputation_change);
    if (reputationUpdates && reputationUpdates.length > 0) {
        const repText = reputationUpdates.map(f => {
            const val = f.reputation_change!.value;
            const sign = val >= 0 ? '+' : '';
            const arrow = val > 0 ? '⬆️' : val < 0 ? '⬇️' : '➡️';
            return `${arrow} **${f.name}**: ${sign}${val}\n*${f.reputation_change!.reason}*`;
        }).join('\n');
        embed2.addFields({ name: t(locale, 'publish.reputationField'), value: truncate(repText) });
        embed2HasFields = true;
    }

    if (partyAlignmentChange) {
        const moralVal = partyAlignmentChange.moral_impact ?? 0;
        const ethicalVal = partyAlignmentChange.ethical_impact ?? 0;
        const moralSign = moralVal >= 0 ? '+' : '';
        const ethicalSign = ethicalVal >= 0 ? '+' : '';
        const moralArrow = moralVal > 0 ? '⬆️' : moralVal < 0 ? '⬇️' : '➡️';
        const ethicalArrow = ethicalVal > 0 ? '⬆️' : ethicalVal < 0 ? '⬇️' : '➡️';
        const alignText = `${moralArrow} ${t(locale, 'publish.alignmentMoral')}: **${moralSign}${moralVal}**\n${ethicalArrow} ${t(locale, 'publish.alignmentEthical')}: **${ethicalSign}${ethicalVal}**\n*${partyAlignmentChange.reason}*`;
        embed2.addFields({ name: t(locale, 'publish.alignmentField'), value: truncate(alignText) });
        embed2HasFields = true;
    }

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
                e.type === 'DESTRUCTION' ? '💥' : (e.type === 'CURSE' || e.type === 'CURSE_REVEAL') ? '🩸' :
                e.type === 'TRANSFER' ? '🔄' : e.type === 'REVELATION' ? '💡' :
                e.type === 'OBSERVATION' ? '👁️' : e.type === 'MANUAL_UPDATE' ? '✏️' : '📜';
            artifactLines.push(`${typeEmoji} **${e.name}**: ${e.event}`);
        });
    }
    if (artifactLines.length > 0) {
        embed2.addFields({ name: t(locale, 'publish.artifactsField'), value: truncate(artifactLines.join('\n')) });
        embed2HasFields = true;
    }

    if (characterGrowth && characterGrowth.length > 0) {
        const growthText = characterGrowth.map(g => {
            const typeEmoji = g.type === 'TRAUMA' ? '💔' : g.type === 'ACHIEVEMENT' ? '🏆' :
                g.type === 'RELATIONSHIP' ? '🤝' : g.type === 'BACKGROUND' ? '📖' : '🎯';
            return `${typeEmoji} **${g.name}**: ${g.event}`;
        }).join('\n');
        embed2.addFields({ name: t(locale, 'publish.growthField'), value: truncate(growthText) });
        embed2HasFields = true;
    }

    const significantNpcTypes = new Set(['BETRAYAL', 'DEATH', 'REVELATION', 'ALLIANCE', 'COMBAT']);
    const significantNpcEvents = (npcEvents || []).filter(e => significantNpcTypes.has(e.type));
    if (significantNpcEvents.length > 0) {
        const npcEventsText = significantNpcEvents.map(e => {
            const typeEmoji = e.type === 'DEATH' ? '💀' : e.type === 'BETRAYAL' ? '🗡️' :
                e.type === 'REVELATION' ? '💡' : e.type === 'ALLIANCE' ? '🤝' :
                e.type === 'COMBAT' ? '⚔️' : '📋';
            return `${typeEmoji} **${e.name}**: ${e.event}`;
        }).join('\n');
        embed2.addFields({ name: t(locale, 'publish.significantNpcsField'), value: truncate(npcEventsText) });
        embed2HasFields = true;
    }

    if (worldEvents && worldEvents.length > 0) {
        const worldEventsText = worldEvents.map(e => {
            const typeEmoji = e.type === 'WAR' ? '⚔️' : e.type === 'POLITICS' ? '🏛️' :
                e.type === 'DISCOVERY' ? '🔍' : e.type === 'CALAMITY' ? '🌋' :
                e.type === 'SUPERNATURAL' ? '✨' : e.type === 'DISASTER' ? '🔥' :
                e.type === 'MYTH' ? '📖' : e.type === 'RELIGION' ? '🙏' :
                e.type === 'BIRTH' ? '🌱' : e.type === 'DEATH' ? '💀' :
                e.type === 'CONSTRUCTION' ? '🏗️' : '🌍';
            return `${typeEmoji} ${e.event}`;
        }).join('\n');
        embed2.addFields({ name: t(locale, 'publish.worldChronicleField'), value: truncate(worldEventsText) });
        embed2HasFields = true;
    }

    if (embed2HasFields) {
        await targetChannel.send({ embeds: [embed2] });
    }
    // ------------------------------------

    if (targetChannel.id !== defaultChannel.id) {
        // Status notice in the command channel: guild language, not campaign language.
        await defaultChannel.send(t(getGuildLocale(defaultChannel.guild.id), 'publish.sentTo', { id: sessionId, channel: targetChannel.id }));
    }

    console.log(`📨 Riassunto inviato per sessione ${sessionId} nel canale ${targetChannel.name}!`);
}
