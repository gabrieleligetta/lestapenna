import { TextChannel, EmbedBuilder } from 'discord.js';
import { audioQueue, correctionQueue } from '../queue';
import { ingestSessionRaw, generateSummary, ingestBioEvent, ingestWorldEvent } from '../bard';
import { updateSessionTitle, getSessionCampaignId, addLoot, removeLoot, addQuest, addCharacterEvent, addNpcEvent, addWorldEvent, getExplicitSessionNumber, setSessionNumber, getSessionAuthor, getSessionStartTime, getUserName, getCampaigns, getGuildConfig } from '../db';
import { monitor } from '../monitor';
import { processSessionReport, sendSessionRecap } from '../reporter';
import { client } from '../discord/state';
import { mixSessionAudio } from '../sessionMixer';

const getSummaryChannelId = (guildId: string) => getGuildConfig(guildId, 'summary_channel_id') || process.env.DISCORD_SUMMARY_CHANNEL_ID;

export async function waitForCompletionAndSummarize(sessionId: string, discordChannel: TextChannel) {
    console.log(`[Monitor] Avviato monitoraggio per sessione ${sessionId}...`);

    // Attesa iniziale per permettere ai file di essere accodati
    await new Promise(resolve => setTimeout(resolve, 5000));

    const checkInterval = setInterval(async () => {
        const audioJobs = await audioQueue.getJobs(['waiting', 'active', 'delayed']);
        const correctionJobs = await correctionQueue.getJobs(['waiting', 'active', 'delayed']);

        const sessionAudioJobs = audioJobs.filter(j => !!j && j.data && j.data.sessionId === sessionId);
        const sessionCorrectionJobs = correctionJobs.filter(j => !!j && j.data && j.data.sessionId === sessionId);

        const totalPending = sessionAudioJobs.length + sessionCorrectionJobs.length;

        if (totalPending > 0) {
            const details = [];
            if (sessionAudioJobs.length > 0) details.push(`${sessionAudioJobs.length} audio`);
            if (sessionCorrectionJobs.length > 0) details.push(`${sessionCorrectionJobs.length} correction`);

            console.log(`[Monitor] Sessione ${sessionId}: ancora ${totalPending} file... (${details.join(', ')})`);
        } else {
            process.stdout.write(`\n✅ [Monitor] Sessione ${sessionId}: Elaborazione completata.\n`);
            clearInterval(checkInterval);

            // --- AGGIUNTA: GENERAZIONE MIX AUDIO ---
            try {
                console.log("🎛️ Avvio generazione Master Audio...");
                await mixSessionAudio(sessionId);
            } catch (mixErr: any) {
                console.error(`❌ Errore mixaggio audio ${sessionId}:`, mixErr);
            }
            // ---------------------------------------

            const startSummary = Date.now();

            // FASE 1: INGESTIONE (Separata)
            try {
                await discordChannel.send("🧠 Il Bardo sta studiando gli eventi per ricordarli in futuro...");
                await ingestSessionRaw(sessionId);
                await discordChannel.send("✅ Memoria aggiornata.");
            } catch (ingestErr: any) {
                console.error(`⚠️ Errore ingestione ${sessionId}:`, ingestErr);
                await discordChannel.send(`⚠️ Ingestione memoria fallita: ${ingestErr.message}. Puoi riprovare più tardi con \`$memorizza ${sessionId}\`.`);
                // Non blocchiamo il riassunto
            }

            // FASE 2: RIASSUNTO
            try {
                await discordChannel.send("✍️ Inizio stesura del racconto...");
                const result = await generateSummary(sessionId, 'DM');

                // SALVATAGGIO TITOLO
                updateSessionTitle(sessionId, result.title);

                // --- AUTOMAZIONE DB: LOOT & QUEST ---
                const activeCampaignId = getSessionCampaignId(sessionId);
                if (activeCampaignId) {
                    if (result.loot && result.loot.length > 0) {
                        result.loot.forEach((item: string) => addLoot(activeCampaignId, item));
                    }

                    if (result.loot_removed && result.loot_removed.length > 0) {
                        result.loot_removed.forEach((item: string) => removeLoot(activeCampaignId, item));
                    }

                    if (result.quests && result.quests.length > 0) {
                        result.quests.forEach((q: string) => addQuest(activeCampaignId, q));
                    }

                    // --- GESTIONE CRESCITA PG ---
                    if (result.character_growth && Array.isArray(result.character_growth)) {
                        for (const growth of result.character_growth) {
                            if (growth.name && growth.event) {
                                // 1. Salva nella tabella storica dedicata
                                addCharacterEvent(activeCampaignId, growth.name, sessionId, growth.event, growth.type || 'GENERIC');

                                // 2. INTEGRAZIONE RAG (Per il comando $chiedialbardo) [ORA IMPLEMENTATO]
                                // Vettorializza l'evento così il Bardo "capisce" e "ricorda" i cambiamenti psicologici
                                // Lo eseguiamo senza await per non bloccare l'invio del riassunto in chat
                                ingestBioEvent(activeCampaignId, sessionId, growth.name, growth.event, growth.type || 'GENERIC')
                                    .catch(err => console.error(`Errore ingestione bio per ${growth.name}:`, err));
                            }
                        }
                    }
                    // ----------------------------

                    // --- GESTIONE EVENTI NPC ---
                    if (result.npc_events && Array.isArray(result.npc_events)) {
                        for (const evt of result.npc_events) {
                            if (evt.name && evt.event) {
                                // 1. STORIA NARRATIVA NPC
                                addNpcEvent(activeCampaignId, evt.name, sessionId, evt.event, evt.type || 'GENERIC');

                                // 2. INTEGRAZIONE RAG (Così il Bardo sa cosa ha fatto l'NPC)
                                ingestBioEvent(activeCampaignId, sessionId, evt.name, evt.event, evt.type || 'GENERIC')
                                    .catch(err => console.error(`Errore ingestione bio NPC ${evt.name}:`, err));
                            }
                        }
                    }
                    // ---------------------------

                    // --- GESTIONE EVENTI MONDO ---
                    if (result.world_events && Array.isArray(result.world_events)) {
                        for (const w of result.world_events) {
                            if (w.event) {
                                // 1. TIMELINE CRONOLOGICA
                                addWorldEvent(activeCampaignId, sessionId, w.event, w.type || 'GENERIC');

                                // 2. RAG (Lore Generale)
                                ingestWorldEvent(activeCampaignId, sessionId, w.event, w.type || 'GENERIC')
                                    .catch(err => console.error(`Errore ingestione mondo:`, err));
                            }
                        }
                    }
                    // -----------------------------
                }
                // ------------------------------------

                monitor.logSummarizationTime(Date.now() - startSummary);
                monitor.logTokenUsage(result.tokens);

                await publishSummary(sessionId, result.summary, discordChannel, false, result.title, result.loot, result.quests, result.narrative);

                // --- INVIO EMAIL DM ---
                if (activeCampaignId) {
                    // Inviamo l'email in background senza bloccare il bot
                    sendSessionRecap(
                        sessionId,
                        activeCampaignId,
                        result.summary,
                        result.loot,
                        result.loot_removed,
                        result.narrative // NUOVO PARAMETRO
                    ).catch(e => console.error("Errore async email:", e));

                    await discordChannel.send("📧 Ho inviato una pergamena (email) di riepilogo al Dungeon Master.");
                }
                // ---------------------

            } catch (err: any) {
                console.error(`❌ Errore riassunto finale ${sessionId}:`, err);
                monitor.logError('Summary', err.message);
                await discordChannel.send(`⚠️ Errore riassunto. Riprova: \`$racconta ${sessionId}\`.`);
            }

            const metrics = monitor.endSession();
            if (metrics) {
                processSessionReport(metrics).catch(e => console.error(e));
            }
        }
    }, 10000);
}

async function fetchSessionInfoFromHistory(channel: TextChannel, targetSessionId?: string): Promise<{ lastRealNumber: number, sessionNumber?: number }> {
    let lastRealNumber = 0;
    let foundSessionNumber: number | undefined;

    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const sortedMessages = Array.from(messages.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);

        for (const msg of sortedMessages) {
            const sessionMatch = msg.content.match(/-SESSIONE\s+(\d+)/i);
            const idMatch = msg.content.match(/\[ID: ([a-f0-9-]+)\]/i);
            const isReplay = msg.content.includes("(REPLAY)");

            if (sessionMatch) {
                const num = parseInt(sessionMatch[1]);
                if (!isNaN(num)) {
                    if (!isReplay && lastRealNumber === 0) {
                        lastRealNumber = num;
                    }
                    if (targetSessionId && idMatch && idMatch[1] === targetSessionId) {
                        foundSessionNumber = num;
                    }
                    if (!targetSessionId && lastRealNumber !== 0) break;
                    if (targetSessionId && lastRealNumber !== 0 && foundSessionNumber !== undefined) break;
                }
            }
        }
    } catch (e) {
        console.error("❌ Errore durante il recupero della cronologia del canale:", e);
    }

    return { lastRealNumber, sessionNumber: foundSessionNumber };
}

export async function publishSummary(sessionId: string, summary: string, defaultChannel: TextChannel, isReplay: boolean = false, title?: string, loot?: string[], quests?: string[], narrative?: string) {
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

    // --- NUOVO: RACCONTO NARRATIVO ---
    if (narrative && narrative.length > 10) {
        await targetChannel.send(`### 📖 Racconto`);
        const narrativeChunks = narrative.match(/[\s\S]{1,1900}/g) || [];
        for (const chunk of narrativeChunks) {
            await targetChannel.send(chunk);
        }
        await targetChannel.send(`---\n`); // Separatore
    }
    // ---------------------------------

    const chunks = summary.match(/[\s\S]{1,1900}/g) || [];
    for (const chunk of chunks) {
        await targetChannel.send(chunk);
    }

    // --- VISUALIZZAZIONE LOOT & QUEST ---
    if ((loot && loot.length > 0) || (quests && quests.length > 0)) {
        const embed = new EmbedBuilder()
            .setColor("#F1C40F")
            .setTitle("🎒 Riepilogo Tecnico");

        if (loot && loot.length > 0) {
            embed.addFields({ name: "💰 Bottino (Loot)", value: loot.map(i => `• ${i}`).join('\n') });
        }

        if (quests && quests.length > 0) {
            embed.addFields({ name: "🗺️ Missioni (Quests)", value: quests.map(q => `• ${q}`).join('\n') });
        }

        await targetChannel.send({ embeds: [embed] });
    }
    // ------------------------------------

    if (targetChannel.id !== defaultChannel.id) {
        await defaultChannel.send(`✅ Riassunto della sessione \`${sessionId}\` inviato in <#${targetChannel.id}>`);
    }

    console.log(`📨 Riassunto inviato per sessione ${sessionId} nel canale ${targetChannel.name}!`);
}
