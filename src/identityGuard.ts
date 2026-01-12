import { Message, TextChannel } from 'discord.js';
import { db, addPendingMerge, removePendingMerge, getAllPendingMerges, PendingMerge, getNpcEntry } from './db';
import { resolveIdentityCandidate } from './bard';

// RAM Cache
const pendingMergesMap = new Map<string, PendingMerge>();

export function initIdentityGuard() {
    const saved = getAllPendingMerges();
    saved.forEach(p => pendingMergesMap.set(p.message_id, p));
    console.log(`[IdentityGuard] 🛡️ Ripristinati ${saved.length} merge in sospeso dal DB.`);
}

export async function checkAndPromptMerge(
    campaignId: number, 
    npc: { name: string, description: string, role: string }, 
    channel: TextChannel
): Promise<boolean> {
    
    const resolution = await resolveIdentityCandidate(campaignId, npc.name, npc.description);
    
    // Threshold: Only ask if fairly confident it's a duplicate
    if (resolution.match && resolution.confidence > 0.6) {
        // Double check: if names are identical, skip prompt (handled by DB upsert)
        if (resolution.match.toLowerCase() === npc.name.toLowerCase()) return false;

        const msg = await channel.send(
            `🕵️ **Ipotesi Identità**\n` +
            `Ho trovato: **"${npc.name}"**\n` +
            `Credo sia: **"${resolution.match}"**\n` +
            `*Descrizione: ${npc.description.substring(0, 100)}...*\n\n` +
            `👉 **Opzioni di Risposta:**\n` +
            `- **SI**: Conferma il merge con **${resolution.match}**.\n` +
            `- **NUOVO**: Crea come nuovo personaggio.\n` +
            `- **[NomeReale]**: Scrivi il nome di un altro NPC esistente per unirlo a lui.`
        );

        const data: PendingMerge = {
            message_id: msg.id,
            campaign_id: campaignId,
            detected_name: npc.name,
            target_name: resolution.match,
            new_description: npc.description,
            role: npc.role
        };

        // Save to DB and RAM
        addPendingMerge(data);
        pendingMergesMap.set(msg.id, data);
        
        return true; // We handled it (put in pending), so stop normal flow
    }

    return false; // Not a duplicate, proceed normal flow
}

export async function handleIdentityReply(message: Message) {
    // 1. Validate Reference
    if (!message.reference?.messageId) return;
    const data = pendingMergesMap.get(message.reference.messageId);
    if (!data) return; 

    let content = message.content.trim();
    const upperContent = content.toUpperCase();
    
    // --- CASE 1: CONFIRM AI (SI) ---
    if (['SI', 'SÌ', 'YES', 'Y'].includes(upperContent)) {
        const existing = getNpcEntry(data.campaign_id, data.target_name);
        if (existing) {
            const mergedDesc = `${existing.description} | [${data.detected_name}]: ${data.new_description}`;
            db.prepare(`UPDATE npcdossier SET description = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(mergedDesc, existing.id);
            await message.reply(`✅ **Unito!** Dati di "${data.detected_name}" aggiunti a **${data.target_name}**.`);
        } else {
            await message.reply(`⚠️ Errore: **${data.target_name}** non trovato nel DB.`);
        }
        cleanup(data.message_id);
        return;
    } 
    
    // --- CASE 2: CREATE NEW (NO/NUOVO) ---
    if (['NO', 'NEW', 'NUOVO', 'N'].includes(upperContent)) {
        db.prepare(`INSERT INTO npcdossier (campaign_id, name, description, role, status) VALUES (?, ?, ?, ?, 'ALIVE')`)
          .run(data.campaign_id, data.detected_name, data.new_description, data.role);
        await message.reply(`🆕 **Creato!** Benvenuto **${data.detected_name}**.`);
        cleanup(data.message_id);
        return;
    }

    // --- CASE 3: MANUAL OVERRIDE (Specific Name) ---
    // Clean input (e.g. "No è Brom" -> "Brom")
    const manualName = content.replace(/^(no|è|e'|is|it's)\s+/i, '').trim();
    
    // Check DB for manual match
    const manualMatch = getNpcEntry(data.campaign_id, manualName);

    if (manualMatch) {
        // Merge into the MANUALLY selected NPC
        const mergedDesc = `${manualMatch.description} | [${data.detected_name}]: ${data.new_description}`;
        db.prepare(`UPDATE npcdossier SET description = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(mergedDesc, manualMatch.id);
        
        await message.reply(`↩️ **Corretto!** Ho unito "${data.detected_name}" a **${manualMatch.name}** (invece di ${data.target_name}).`);
        cleanup(data.message_id);
    } else {
        // Not found -> Warn user but keep listening
        await message.reply(
            `❓ Non trovo l'NPC **"${manualName}"** nel database.\n` +
            `- Scrivi **NUOVO** per creare un personaggio nuovo.\n` +
            `- Controlla il nome dell'NPC esistente.`
        );
    }
}

function cleanup(msgId: string) {
    removePendingMerge(msgId);
    pendingMergesMap.delete(msgId);
}
