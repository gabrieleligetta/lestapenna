import { Message, TextChannel } from 'discord.js';
import {
    db,
    addPendingMerge,
    removePendingMerge,
    getAllPendingMerges,
    PendingMerge,
    getNpcEntry,
    migrateKnowledgeFragments,
    markNpcDirty,
    npcRepository
} from '../db';
import { resolveIdentityCandidate, smartMergeBios } from '../bard';
import { getGuildLocale, t } from '../i18n';

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
    const locale = getGuildLocale(channel.guild.id, channel.guild.preferredLocale);

    const resolution = await resolveIdentityCandidate(campaignId, npc.name, npc.description);

    // No match or too low confidence → proceed with normal flow
    if (!resolution.match || resolution.confidence <= 0.6) return false;

    // If names are identical (case-insensitive), skip prompt (handled by DB upsert)
    if (resolution.match.toLowerCase() === npc.name.toLowerCase()) return false;

    // High confidence (syntactic auto-merge: typo, prefix, exact) → merge silently
    if (resolution.confidence >= 0.95) {
        const existing = getNpcEntry(campaignId, resolution.match);
        if (existing) {
            const mergedDesc = await smartMergeBios(resolution.match, existing.description || '', npc.description);

            db.prepare('UPDATE npc_dossier SET description = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?')
                .run(mergedDesc, existing.id);

            migrateKnowledgeFragments(campaignId, npc.name, resolution.match);
            markNpcDirty(campaignId, resolution.match);

            console.log(`[IdentityGuard] ⚡ Auto-merge silenzioso: "${npc.name}" → "${resolution.match}" (confidence=${resolution.confidence.toFixed(2)})`);
            return true;
        }
    }

    // Medium confidence (AI-confirmed or moderate syntactic) → ask user
    const msg = await channel.send(t(locale, 'identity.hypothesis', {
        detected: npc.name, target: resolution.match,
        description: npc.description.substring(0, 100),
    }));

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

export async function handleIdentityReply(message: Message) {
    // 1. Validate Reference
    if (!message.reference?.messageId) return;
    const data = pendingMergesMap.get(message.reference.messageId);
    if (!data) return;
    const locale = message.guild
        ? getGuildLocale(message.guild.id, message.guild.preferredLocale)
        : 'en';

    let content = message.content.trim();
    const upperContent = content.toUpperCase();

    // --- CASE 1: CONFIRM AI (SI) ---
    if (['SI', 'SÌ', 'SÍ', 'YES', 'Y', 'OUI', 'JA', 'SIM'].includes(upperContent)) {
        const existing = getNpcEntry(data.campaign_id, data.target_name);
        if (existing) {
            const loadingMsg = await message.reply(t(locale, 'identity.merging'));

            // 🧠 AI Merge
            const mergedDesc = await smartMergeBios(data.target_name, existing.description || '', data.new_description);

            db.prepare('UPDATE npc_dossier SET description = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?')
                .run(mergedDesc, existing.id);

            // ✅ NUOVO: Migra riferimenti RAG
            migrateKnowledgeFragments(data.campaign_id, data.detected_name, data.target_name);

            // ✅ NUOVO: Marca per sync lazy
            markNpcDirty(data.campaign_id, data.target_name);

            await loadingMsg.edit(t(locale, 'identity.merged', { name: data.target_name }));
        } else {
            await message.reply(t(locale, 'identity.notFound', { name: data.target_name }));
        }
        cleanup(data.message_id);
        return;
    }

    // --- CASE 2: CREATE NEW (NO/NUOVO) ---
    if (['NO', 'NEW', 'NUOVO', 'NUEVO', 'NOUVEAU', 'NEU', 'NOVO', 'N'].includes(upperContent)) {
        npcRepository.updateNpcEntry(data.campaign_id, data.detected_name, data.new_description, data.role, 'ALIVE');
        await message.reply(t(locale, 'identity.created', { name: data.detected_name }));
        cleanup(data.message_id);
        return;
    }

    // --- CASE 3: MANUAL OVERRIDE (Specific Name) ---
    // Clean input (e.g. "No è Brom" -> "Brom")
    const manualName = content.replace(/^(no|è|e'|is|it's)\s+/i, '').trim();

    // Check DB for manual match
    const manualMatch = getNpcEntry(data.campaign_id, manualName);

    if (manualMatch) {
        const loadingMsg = await message.reply(t(locale, 'identity.mergingWith', { name: manualMatch.name }));

        const mergedDesc = await smartMergeBios(manualMatch.name, manualMatch.description || '', data.new_description);

        db.prepare('UPDATE npc_dossier SET description = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?')
            .run(mergedDesc, manualMatch.id);

        // ✅ NUOVO
        migrateKnowledgeFragments(data.campaign_id, data.detected_name, manualMatch.name);
        markNpcDirty(data.campaign_id, manualMatch.name);

        await loadingMsg.edit(t(locale, 'identity.corrected', { name: manualMatch.name }));
        cleanup(data.message_id);
    } else {
        // Not found -> Warn user but keep listening
        await message.reply(t(locale, 'identity.manualNotFound', { name: manualName }));
    }
}

function cleanup(msgId: string) {
    removePendingMerge(msgId);
    pendingMergesMap.delete(msgId);
}
