import Database from 'better-sqlite3';

const db = new Database(process.env.DB_PATH || 'data/prod_fresh.db', { readonly: true, fileMustExist: true });

function normalizeForIndex(str: string): string {
    return str
        .toLowerCase()
        .trim()
        .replace(/^(il|lo|la|i|gli|le|un|uno|una|the|a|an)\s+/, '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ');
}

function extractTrigrams(s: string): Set<string> {
    const padded = ` ${s} `;
    const t = new Set<string>();
    for (let i = 0; i <= padded.length - 3; i++) t.add(padded.substring(i, i + 3));
    return t;
}

function jaccard(a: Set<string>, b: Set<string>): number {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const u = a.size + b.size - inter;
    return u === 0 ? 0 : inter / u;
}

function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const prev = new Array(n + 1);
    const cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
}

const levSim = (a: string, b: string) => 1 - levenshtein(a, b) / Math.max(a.length, b.length);

const cid = Number(process.argv[2] || 2);
const rows = db.prepare('SELECT id, short_id, name, description FROM artifacts WHERE campaign_id = ? ORDER BY id').all(cid) as any[];
console.log(`\n${rows.length} artifacts in campaign ${cid}`);

interface E { id: number; short_id: string; name: string; norm: string; trigrams: Set<string>; }
const ents: E[] = rows.map((r) => ({ id: r.id, short_id: r.short_id, name: r.name, norm: normalizeForIndex(r.name), trigrams: extractTrigrams(r.name) }));

const parent = new Map<number, number>();
const find = (x: number): number => { while (parent.get(x)! !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
for (const e of ents) parent.set(e.id, e.id);
const reason = new Map<string, string>();
const edge = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Pass 1
const byNorm = new Map<string, E[]>();
for (const e of ents) { if (!byNorm.has(e.norm)) byNorm.set(e.norm, []); byNorm.get(e.norm)!.push(e); }
for (const g of byNorm.values()) { for (let i = 1; i < g.length; i++) { union(g[0].id, g[i].id); reason.set(edge(g[0].id, g[i].id), 'exact_normalized'); } }

// Pass 2
for (const a of ents) {
    for (const b of ents) {
        if (a.id >= b.id) continue;
        const trig = jaccard(a.trigrams, b.trigrams);
        const lev = levSim(a.norm, b.norm);
        const combined = trig * 0.4 + lev * 0.6;
        if (combined >= 0.5) {
            union(a.id, b.id);
            reason.set(edge(a.id, b.id), `combined=${combined.toFixed(2)} (trig=${trig.toFixed(2)},lev=${lev.toFixed(2)})`);
        }
    }
}

const groups = new Map<number, E[]>();
for (const e of ents) { const r = find(e.id); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(e); }

let any = false;
for (const g of groups.values()) {
    if (g.length < 2) continue;
    any = true;
    console.log(`\n— Cluster:`);
    for (const e of g) console.log(`   id=${e.id} short_id=${e.short_id} "${e.name}"  norm="${e.norm}"`);
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) console.log(`   ${edge(g[i].id, g[j].id)}: ${reason.get(edge(g[i].id, g[j].id)) || '?'}`);
}
if (!any) console.log('  (nessun cluster ≥2)');

// Corona specific
console.log(`\n— Corona pair detail:`);
const corona = ents.filter((e) => /corona di spine/i.test(e.name));
for (const e of corona) console.log(`   "${e.name}"  norm="${e.norm}"  trigrams=${e.trigrams.size}`);
if (corona.length === 2) {
    const trig = jaccard(corona[0].trigrams, corona[1].trigrams);
    const lev = levSim(corona[0].norm, corona[1].norm);
    console.log(`   combined = ${((trig * 0.4 + lev * 0.6)).toFixed(3)}  (trig=${trig.toFixed(3)}, lev=${lev.toFixed(3)})  → ${trig * 0.4 + lev * 0.6 >= 0.5 ? 'CLUSTER' : 'no cluster'}`);
}
db.close();