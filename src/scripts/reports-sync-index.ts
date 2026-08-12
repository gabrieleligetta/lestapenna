/**
 * Regenerate `reports/index.json` from the individual `reports/NNNNNN.json`
 * files in the configured reports bucket.
 *
 * Used after the AI agent (or the dev) updates a report's status/resolution
 * directly in its per-report JSON, so the aggregate index reflects the new
 * state without the agent having to hand-edit the index file.
 *
 *   npm run reports:sync-index
 *
 * Talks only to the reports bucket (OCI in prod/preview, local in tests) —
 * never the DB, Discord, or Redis — so it is safe to run from anywhere with
 * the right OCI credentials.
 */
import { ReportsService } from '../api/reports/reports.service';
import { config } from '../config';

async function main(): Promise<void> {
    const service = new ReportsService();
    await service.refreshIndex();
    const driver = config.reportsStorage.driver;
    const bucket = config.reportsStorage.bucketName ?? config.reportsStorage.localDirectory;
    console.log(`Reports index regenerated (${driver}: ${bucket}).`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Failed to regenerate the reports index:', err);
        process.exit(1);
    });