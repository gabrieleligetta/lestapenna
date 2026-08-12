import { ReportsStorage } from '../services/reportsStorage';
import * as fs from 'fs';

const reportId = process.argv[2];
if (!reportId) {
  console.error('Usage: ts-node src/scripts/reports-download.ts <NNNNNN> [outDir]');
  process.exit(1);
}
const outDir = process.argv[3] ?? '.';

async function main() {
  const s = new ReportsStorage();
  const buf = await s.readBuffer(`reports/${reportId}/screenshot.webp`);
  if (!buf) {
    console.error('No screenshot found for report', reportId);
    process.exit(1);
  }
  const outPath = `${outDir}/report-${reportId}-screenshot.webp`;
  fs.writeFileSync(outPath, buf);
  console.log('written', outPath, buf.length, 'bytes');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
