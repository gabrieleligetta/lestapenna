import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Worker } from 'worker_threads';

interface ProbeResult {
    workerId: number;
    writes: number;
    busyErrors: number;
    otherErrors: string[];
    latenciesMs: number[];
}

const writerSource = String.raw`
const Database = require('better-sqlite3');
const { performance } = require('perf_hooks');
const { parentPort, workerData } = require('worker_threads');

const db = new Database(workerData.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');
const insert = db.prepare(
    'INSERT INTO contention_probe (writer_id, sequence_no, payload) VALUES (?, ?, ?)'
);
const latenciesMs = [];
let busyErrors = 0;
const otherErrors = [];

for (let sequence = 0; sequence < workerData.writes; sequence++) {
    const startedAt = performance.now();
    try {
        insert.run(workerData.workerId, sequence, 'x'.repeat(256));
    } catch (error) {
        if (error && error.code === 'SQLITE_BUSY') busyErrors++;
        else otherErrors.push(error instanceof Error ? error.message : String(error));
    } finally {
        latenciesMs.push(performance.now() - startedAt);
    }
}

db.close();
parentPort.postMessage({
    workerId: workerData.workerId,
    writes: workerData.writes,
    busyErrors,
    otherErrors,
    latenciesMs,
});
`;

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values: number[], fraction: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
    return sorted[index];
}

function startWriter(dbPath: string, workerId: number, writes: number): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(writerSource, {
            eval: true,
            workerData: { dbPath, workerId, writes },
        });
        worker.once('message', (result: ProbeResult) => resolve(result));
        worker.once('error', reject);
        worker.once('exit', code => {
            if (code !== 0) reject(new Error(`SQLite probe worker ${workerId} exited with code ${code}`));
        });
    });
}

async function main(): Promise<void> {
    const writerCount = positiveInteger(process.env.SQLITE_PROBE_WRITERS, 3);
    const writesPerWorker = positiveInteger(process.env.SQLITE_PROBE_WRITES, 1000);
    const probeDirectory = mkdtempSync(join(tmpdir(), 'lestapenna-sqlite-probe-'));
    const dbPath = join(probeDirectory, 'probe.db');

    try {
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 10000');
        db.exec(`
            CREATE TABLE contention_probe (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                writer_id INTEGER NOT NULL,
                sequence_no INTEGER NOT NULL,
                payload TEXT NOT NULL,
                UNIQUE (writer_id, sequence_no)
            )
        `);
        db.close();

        const results = await Promise.all(
            Array.from({ length: writerCount }, (_, workerId) =>
                startWriter(dbPath, workerId, writesPerWorker),
            ),
        );
        const verificationDb = new Database(dbPath, { readonly: true });
        const row = verificationDb.prepare('SELECT COUNT(*) AS count FROM contention_probe').get() as { count: number };
        verificationDb.close();

        const latencies = results.flatMap(result => result.latenciesMs);
        const busyErrors = results.reduce((total, result) => total + result.busyErrors, 0);
        const otherErrors = results.flatMap(result => result.otherErrors);
        const expectedRows = writerCount * writesPerWorker;
        const report = {
            writers: writerCount,
            writesPerWorker,
            expectedRows,
            persistedRows: row.count,
            busyErrors,
            otherErrors,
            latencyMs: {
                p50: Number(percentile(latencies, 0.5).toFixed(2)),
                p95: Number(percentile(latencies, 0.95).toFixed(2)),
                p99: Number(percentile(latencies, 0.99).toFixed(2)),
                max: Number(Math.max(...latencies).toFixed(2)),
            },
        };

        console.log(JSON.stringify(report, null, 2));
        if (busyErrors > 0 || otherErrors.length > 0 || row.count !== expectedRows) {
            process.exitCode = 1;
        }
    } finally {
        rmSync(probeDirectory, { recursive: true, force: true });
    }
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
