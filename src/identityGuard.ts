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
            `*Descrizione: ${npc.description.substring(0, 100)}...*\n` +
            `👉 **Rispondi:** "SI" per unire, "NO" per creare nuovo.`
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
    if (!message.reference?.messageId) return;
    
    const data = pendingMergesMap.get(message.reference.messageId);
    if (!data) return; // Not a monitored message

    const content = message.content.trim().toUpperCase();
    
    if (['SI', 'SÌ', 'YES', 'Y'].includes(content)) {
        // EXECUTE MERGE
        const existing = getNpcEntry(data.campaign_id, data.target_name);
        if (existing) {
            const mergedDesc = `${existing.description} | [${data.detected_name}]: ${data.new_description}`;
            db.prepare(`UPDATE npcdossier SET description = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(mergedDesc, existing.id);
            await message.reply(`✅ Unito **${data.detected_name}** in **${data.target_name}**.`);
        } else {
            await message.reply(`⚠️ Errore: ${data.target_name} non esiste più.`);
        }
    } else if (['NO', 'NEW', 'N'].includes(content)) {
        // CREATE NEW
        db.prepare(`INSERT INTO npcdossier (campaign_id, name, description, role, status) VALUES (?, ?, ?, ?, 'ALIVE')`)
          .run(data.campaign_id, data.detected_name, data.new_description, data.role);
        await message.reply(`🆕 Creato **${data.detected_name}**.`);
    } else {
        return; // Ignore invalid responses
    }

    // Cleanup
    removePendingMerge(data.message_id);
    pendingMergesMap.delete(data.message_id);
}
