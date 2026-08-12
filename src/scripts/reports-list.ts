import { ReportsStorage } from '../services/reportsStorage';

async function main() {
  const s = new ReportsStorage();
  const keys = await s.list('reports/');
  const jsonKeys = keys.filter((k) => /^reports\/\d{6}\.json$/.test(k)).sort();
  for (const key of jsonKeys) {
    const buf = await s.readBuffer(key);
    if (!buf) continue;
    const r = JSON.parse(buf.toString('utf8'));
    console.log('---');
    console.log(JSON.stringify(r, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
