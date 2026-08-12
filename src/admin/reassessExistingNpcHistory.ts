/**
 * One-off backfill: re-runs the motive-aware moral/ethical reassessment
 * (src/bard/moralReassessment.ts) against ALREADY PERSISTED npc_history rows, so NPCs
 * scored before this fix landed (e.g. Helena) can be corrected without waiting for a
 * new session to touch them.
 *
 * `rebuildAlignment.rebuildNpcs` alone does NOT fix this: it only re-aggregates
 * already-stored moral_weight/ethical_weight values, which are frozen at whatever the
 * old rigid category table assigned. This script rewrites the weights themselves first;
 * run rebuildAlignment.rebuildAll afterward to recompute npc_dossier scores from them.
 *
 * Usage:
 *   npx ts-node src/admin/reassessExistingNpcHistory.ts --dry-run [--campaign <id>]
 *   npx ts-node src/admin/reassessExistingNpcHistory.ts --campaign <id>   (writes changes)
 *
 * Without --campaign, processes every campaign found. --dry-run logs the before/after
 * diff without writing anything — always run with --dry-run first.
 */

import { db } from '../db/client';
import { getNpcEntry, getNpcHistory } from '../db';
import { reassessNpcMoralWeights, MoralReassessmentCandidate } from '../bard/moralReassessment';

interface NonZeroHistoryRow {
    id: number;
    campaign_id: number;
    npc_name: string;
    event_type: string;
    description: string;
    moral_weight: number;
    ethical_weight: number;
}

function parseArgs(argv: string[]): { dryRun: boolean; campaignId: number | null } {
    const dryRun = argv.includes('--dry-run');
    const campaignFlagIndex = argv.indexOf('--campaign');
    const campaignId = campaignFlagIndex !== -1 && argv[campaignFlagIndex + 1]
        ? Number(argv[campaignFlagIndex + 1])
        : null;
    return { dryRun, campaignId };
}

async function run() {
    const { dryRun, campaignId } = parseArgs(process.argv.slice(2));

    if (!dryRun) {
        console.log('⚠️  Modalità SCRITTURA attiva (nessun --dry-run). I pesi verranno aggiornati nel DB.');
    } else {
        console.log('🔍 Modalità --dry-run: nessuna scrittura, solo diff mostrato.');
    }

    const rows = db.prepare(`
        SELECT id, campaign_id, npc_name, event_type, description, moral_weight, ethical_weight
        FROM npc_history
        WHERE (moral_weight != 0 OR ethical_weight != 0)
        ${campaignId !== null ? 'AND campaign_id = ?' : ''}
        ORDER BY campaign_id, npc_name, timestamp ASC
    `).all(...(campaignId !== null ? [campaignId] : [])) as NonZeroHistoryRow[];

    if (rows.length === 0) {
        console.log('Nessun evento con peso morale/etico non-zero trovato.');
        return;
    }

    // Group by campaign + npc name, so each NPC's events share dossier description + siblings as context.
    const byNpc = new Map<string, NonZeroHistoryRow[]>();
    for (const row of rows) {
        const key = `${row.campaign_id}::${row.npc_name}`;
        if (!byNpc.has(key)) byNpc.set(key, []);
        byNpc.get(key)!.push(row);
    }

    let totalChanged = 0;
    let totalUnchanged = 0;

    for (const [key, npcRows] of byNpc) {
        const [campId, npcName] = key.split('::');
        const cId = Number(campId);
        const npc = getNpcEntry(cId, npcName);
        const dossierDescription = npc?.description || '';

        const candidates: MoralReassessmentCandidate[] = npcRows.map(row => {
            const siblingHistory = npcRows
                .filter(r => r.id !== row.id)
                .map(r => `[${r.event_type}] ${r.description}`)
                .slice(-10)
                .join('; ');
            return {
                name: npcName,
                event: row.description,
                type: row.event_type,
                moral_impact: row.moral_weight,
                ethical_impact: row.ethical_weight,
                dossierDescription,
                recentHistory: siblingHistory
            };
        });

        console.log(`\n=== ${npcName} (campagna ${cId}) — ${candidates.length} evento/i non-zero ===`);
        const reassessed = await reassessNpcMoralWeights(candidates);

        for (let i = 0; i < npcRows.length; i++) {
            const row = npcRows[i];
            const revised = reassessed[i];
            const changed = revised.moral_impact !== row.moral_weight || revised.ethical_impact !== row.ethical_weight;

            if (changed) {
                totalChanged++;
                console.log(`  [${row.event_type}] id=${row.id}: moral ${row.moral_weight}→${revised.moral_impact}, ethical ${row.ethical_weight}→${revised.ethical_impact} (${revised.motive})`);
                console.log(`    "${row.description.slice(0, 120)}${row.description.length > 120 ? '…' : ''}"`);
                if (!dryRun) {
                    db.prepare('UPDATE npc_history SET moral_weight = ?, ethical_weight = ? WHERE id = ?')
                        .run(revised.moral_impact, revised.ethical_impact, row.id);
                }
            } else {
                totalUnchanged++;
            }
        }
    }

    console.log(`\n📊 Riepilogo: ${totalChanged} eventi modificati, ${totalUnchanged} invariati (su ${rows.length} totali).`);
    if (dryRun) {
        console.log('Nessuna scrittura effettuata (--dry-run). Rilancia senza --dry-run per applicare.');
    } else {
        console.log('Scrittura completata. Rilancia rebuildAlignment.rebuildAll (o src/admin/run_rebuild.ts) per ricalcolare i punteggi npc_dossier dai nuovi pesi.');
    }
}

run().catch((err) => {
    console.error('Errore durante il reassessment:', err);
    process.exit(1);
});
