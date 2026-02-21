import { db } from '../client';

export function alignEnumsToEnglish() {
    console.log("[Maintenance] Sto allineando le stringhe ENUM dall'Italiano all'Inglese...");

    db.transaction(() => {
        // Morale Translation Map
        const moralMap: Record<string, string> = {
            'BUONO': 'GOOD',
            'NEUTRALE': 'NEUTRAL',
            'CATTIVO': 'EVIL'
        };

        // Etico Translation Map
        const ethicalMap: Record<string, string> = {
            'LEGALE': 'LAWFUL',
            'NEUTRALE': 'NEUTRAL',
            'CAOTICO': 'CHAOTIC'
        };

        // Reputation Translation Map
        const repMap: Record<string, string> = {
            'OSTILE': 'HOSTILE',
            'DIFFIDENTE': 'DISTRUSTFUL',
            'FREDDO': 'COLD',
            'NEUTRALE': 'NEUTRAL',
            'CORDIALE': 'CORDIAL',
            'AMICHEVOLE': 'FRIENDLY',
            'ALLEATO': 'ALLIED'
        };

        // Artifact Status Translation Map
        const artStatusMap: Record<string, string> = {
            'FUNZIONANTE': 'FUNCTIONAL',
            'DISTRUTTO': 'DESTROYED',
            'PERDUTO': 'LOST',
            'SIGILLATO': 'SEALED',
            'DORMIENTE': 'DORMANT'
        };

        // --- 1. Campaigns ---
        for (const [it, en] of Object.entries(moralMap)) {
            db.prepare(`UPDATE campaigns SET party_alignment_moral = ? WHERE party_alignment_moral = ?`).run(en, it);
        }
        for (const [it, en] of Object.entries(ethicalMap)) {
            db.prepare(`UPDATE campaigns SET party_alignment_ethical = ? WHERE party_alignment_ethical = ?`).run(en, it);
        }

        // --- 2. NPC Dossier ---
        for (const [it, en] of Object.entries(moralMap)) {
            db.prepare(`UPDATE npc_dossier SET alignment_moral = ? WHERE alignment_moral = ?`).run(en, it);
        }
        for (const [it, en] of Object.entries(ethicalMap)) {
            db.prepare(`UPDATE npc_dossier SET alignment_ethical = ? WHERE alignment_ethical = ?`).run(en, it);
        }

        // --- 3. Faction Dossier ---
        for (const [it, en] of Object.entries(moralMap)) {
            db.prepare(`UPDATE factions SET alignment_moral = ? WHERE alignment_moral = ?`).run(en, it);
        }
        for (const [it, en] of Object.entries(ethicalMap)) {
            db.prepare(`UPDATE factions SET alignment_ethical = ? WHERE alignment_ethical = ?`).run(en, it);
        }

        // --- 4. Characters ---
        for (const [it, en] of Object.entries(moralMap)) {
            db.prepare(`UPDATE characters SET alignment_moral = ? WHERE alignment_moral = ?`).run(en, it);
        }
        for (const [it, en] of Object.entries(ethicalMap)) {
            db.prepare(`UPDATE characters SET alignment_ethical = ? WHERE alignment_ethical = ?`).run(en, it);
        }

        // --- 5. Faction Reputation ---
        for (const [it, en] of Object.entries(repMap)) {
            db.prepare(`UPDATE faction_reputation SET reputation = ? WHERE reputation = ?`).run(en, it);
        }

        // --- 6. Artifacts ---
        for (const [it, en] of Object.entries(artStatusMap)) {
            db.prepare(`UPDATE artifacts SET status = ? WHERE status = ?`).run(en, it);
        }

    })();

    console.log("[Maintenance] Conversione tipi DB all'Inglese completata.");
}
