/**
 * Updates the status (and agent write-up) of one or more reports directly on
 * the reports bucket — the step described in the reports flow, point 3 ("Close
 * the report in its JSON"), scripted so an agent doesn't hand-roll a
 * read/modify/write snippet every time. Appends to statusHistory (never
 * rewrites it), and does NOT touch reports/index.json — run
 * `npm run reports:sync-index` afterwards so the aggregate index catches up.
 *
 * Usage:
 *   npx ts-node src/scripts/reports-close.ts <NNNNNN>[,<NNNNNN>...] <payload.json>
 *
 * payload.json shape (all fields optional except status):
 *   {
 *     "status": "resolved",              // one of REPORT_STATUSES
 *     "by": "agent",                      // statusHistory entry author, default "agent"
 *     "note": "...",                      // statusHistory note; defaults to `resolution`
 *     "agentAnalysis": "...",             // what caused the problem
 *     "agentCategory": "...",             // e.g. "ui/session-party-list"
 *     "resolution": "..."                 // fix summary + commit/PR reference
 *   }
 *
 * The same payload is applied to every report id passed (comma-separated),
 * matching the common case of closing a batch of reports fixed by one commit.
 *
 * Talks only to the reports bucket (OCI in prod/preview, local in tests) —
 * never the DB, Discord, or Redis — so it is safe to run from anywhere with
 * the right OCI credentials.
 */
import { ReportsStorage } from '../services/reportsStorage';
import { REPORT_STATUSES, type ReportStatus } from '../api/reports/dto/report.dto';

interface ClosePayload {
    status: ReportStatus;
    by?: string;
    note?: string;
    agentAnalysis?: string;
    agentCategory?: string;
    resolution?: string;
}

function parseArgs(): { ids: string[]; payload: ClosePayload } {
    const [idsArg, payloadPath] = process.argv.slice(2);
    if (!idsArg || !payloadPath) {
        console.error('Usage: ts-node src/scripts/reports-close.ts <NNNNNN>[,<NNNNNN>...] <payload.json>');
        process.exit(1);
    }
    const ids = idsArg.split(',').map((id) => id.trim().padStart(6, '0'));
    for (const id of ids) {
        if (!/^\d{6}$/.test(id)) {
            console.error(`Invalid report id: "${id}" (expected 6 digits, e.g. 000008)`);
            process.exit(1);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const raw = require(require('path').resolve(payloadPath));
    if (!raw.status || !REPORT_STATUSES.includes(raw.status)) {
        console.error(`payload.json "status" must be one of: ${REPORT_STATUSES.join(', ')}`);
        process.exit(1);
    }
    return { ids, payload: raw as ClosePayload };
}

async function closeReport(storage: ReportsStorage, id: string, payload: ClosePayload): Promise<void> {
    const key = `reports/${id}.json`;
    const buf = await storage.readBuffer(key);
    if (!buf) throw new Error(`Report ${id} not found at ${key}`);
    const report = JSON.parse(buf.toString('utf8'));

    const now = Date.now();
    const note = payload.note ?? payload.resolution ?? `status → ${payload.status}`;

    report.status = payload.status;
    report.updatedAt = now;
    report.statusHistory.push({
        status: payload.status,
        at: now,
        by: payload.by ?? 'agent',
        note,
    });
    if (payload.agentAnalysis !== undefined) report.agentAnalysis = payload.agentAnalysis;
    if (payload.agentCategory !== undefined) report.agentCategory = payload.agentCategory;
    if (payload.resolution !== undefined) report.resolution = payload.resolution;

    await storage.putJson(key, Buffer.from(JSON.stringify(report, null, 2), 'utf8'));
    console.log(`#${id} → ${payload.status}`);
}

async function main(): Promise<void> {
    const { ids, payload } = parseArgs();
    const storage = new ReportsStorage();
    for (const id of ids) {
        await closeReport(storage, id, payload);
    }
    console.log('Done. Run `npm run reports:sync-index` to refresh reports/index.json.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
