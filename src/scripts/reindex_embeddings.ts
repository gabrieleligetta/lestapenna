/**
 * Reindexes a campaign's memory onto a different embedding model.
 *
 *   npm run rag:reindex -- --campaign 1 --model gemini-embedding-001 --dry-run
 *   npm run rag:reindex -- --campaign 1 --model gemini-embedding-001
 *
 * Needed when the model changes — for example moving from an Ollama on your own
 * PC to a cloud model, so the RAG stops depending on a computer being switched
 * on. Changing model **corrupts nothing but makes everything invisible**:
 * `embedding_model` is a search filter, so the old vectors stay in the database
 * and simply stop being found.
 *
 * **Nothing is deleted.** If the recomputation fails halfway, the campaign goes
 * back to the previous model and keeps working; the fragments that were not
 * recomputed stay where they were, invisible but recoverable with a second
 * pass. `content` is never touched: it is the source you re-embed from.
 */

import { initDatabase } from '../db/schema';
import { db } from '../db/client';
import { estimateReindex, reindexCampaign } from '../bard/rag/reindex';
import { EMBEDDING_MODELS } from '../bard/ai/embeddings';

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
    initDatabase();

    const campaignId = Number(arg('campaign'));
    const model = arg('model');
    const dryRun = process.argv.includes('--dry-run');

    if (!Number.isFinite(campaignId) || !model) {
        console.error('Uso: npm run rag:reindex -- --campaign <id> --model <modello> [--dry-run]');
        console.error(`Modelli noti: ${Object.keys(EMBEDDING_MODELS).join(', ')}`);
        process.exit(1);
    }
    if (!EMBEDDING_MODELS[model]) {
        console.error(`Modello sconosciuto: ${model}`);
        process.exit(1);
    }

    const campaign = db.prepare('SELECT id, name, guild_id FROM campaigns WHERE id = ?')
        .get(campaignId) as { id: number; name: string; guild_id: string } | undefined;
    if (!campaign) {
        console.error(`Nessuna campagna con id ${campaignId}.`);
        process.exit(1);
    }

    const estimate = estimateReindex(campaignId, model);
    console.log(`Campagna: ${campaign.name} (gilda ${campaign.guild_id})`);
    console.log(`  modello attuale:  ${estimate.currentModel}`);
    console.log(`  modello nuovo:    ${estimate.targetModel}`);
    console.log(`  frammenti:        ${estimate.fragments}`);
    console.log(`  costo stimato:    ${estimate.estimatedUsd === null ? 'sconosciuto' : `$${estimate.estimatedUsd.toFixed(4)}`}`);

    if (dryRun) {
        console.log('\n--dry-run: nessuna modifica.');
        return;
    }

    console.log('\nRicalcolo in corso...');
    const result = await reindexCampaign(campaignId, model);

    console.log(`\n✅ ${result.reindexed} frammenti reindicizzati su ${result.model}.`);
    if (result.failed > 0) {
        console.warn(
            `⚠️ ${result.failed} non ricalcolati: restano sul modello vecchio, ` +
            'per ora invisibili ma non persi. Rilancia per riprenderli.',
        );
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
