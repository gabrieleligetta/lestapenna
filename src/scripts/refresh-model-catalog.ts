/**
 * Rebuild the model catalogue now, instead of waiting for the nightly job.
 *
 *   npm run models:refresh
 *
 * Useful after a provider releases something, on a fresh installation that has
 * not yet had its first scheduled run, and to check what the curation policy
 * actually keeps.
 *
 * Talks to the two public price databases and to the local DB — never to a
 * provider, so it needs no API key and spends nothing.
 */
import { initDatabase } from '../db';
import { runModelCatalogRefresh } from '../services/modelCatalogRefresh';
import { modelCatalogRepository } from '../db/repositories/ModelCatalogRepository';

async function main(): Promise<void> {
    initDatabase();
    const outcome = await runModelCatalogRefresh();

    if (outcome.sources.length === 0) {
        console.error('No source answered: the stored catalogue was left untouched.');
        process.exitCode = 1;
        return;
    }

    for (const kind of ['text', 'transcription'] as const) {
        console.log(`\n${kind}:`);
        for (const record of modelCatalogRepository.list(kind)) {
            const rate = record.perMinuteUsd !== null
                ? `$${record.perMinuteUsd.toFixed(5)}/min`
                : record.inputPerMillion !== null
                    ? `$${record.inputPerMillion}/$${record.outputPerMillion} per 1M`
                    : 'price unknown';
            const tiers = record.tiers.length ? ` [${record.tiers.join(', ')}]` : '';
            console.log(`  ${record.provider.padEnd(7)} ${record.modelId.padEnd(34)} ${rate}${tiers}`);
        }
    }
    console.log(`\nSources: ${outcome.sources.join(', ')}.`);
}

main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
        console.error('Failed to refresh the model catalogue:', err);
        process.exit(1);
    });
