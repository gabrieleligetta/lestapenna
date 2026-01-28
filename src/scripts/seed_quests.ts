
import { db } from '../db/client';
import { addQuest, addQuestEvent } from '../db';
import { QuestStatus } from '../db/types';
import { v4 as uuidv4 } from 'uuid';

const run = async () => {
    console.log("🌱 Seeding Test Quests...");

    // 1. Get Active Campaign
    const campaign = db.prepare("SELECT * FROM campaigns WHERE is_active = 1 LIMIT 1").get() as any;
    if (!campaign) {
        console.error("❌ No active campaign found.");
        return;
    }
    console.log(`✅ Using Campaign: ${campaign.name} (ID: ${campaign.id})`);

    // 2. Get a Session (or create a dummy one if none)
    let session = db.prepare("SELECT * FROM sessions WHERE campaign_id = ? ORDER BY session_number DESC LIMIT 1").get(campaign.id) as any;
    if (!session) {
        console.log("⚠️ No sessions found. Using 'SESSION-SEED'.");
        session = { session_id: 'SESSION-SEED' };
    } else {
        console.log(`✅ Using Session: ${session.session_id} (${session.title || 'Untitled'})`);
    }

    // 3. Define Quests to Add
    const questsToCheck = [
        // Completed - Narrative Context
        { title: "Raggiungere il Castello di Nerithar", status: "COMPLETED", type: "MAJOR", desc: "La compagnia deve attraversare le paludi per raggiungere la roccaforte." },
        { title: "Sconfiggere la Strega Notturna", status: "COMPLETED", type: "MAJOR", desc: "Una minaccia oscura nelle Paludi dei Morti." },
        { title: "Trovare la via segreta", status: "COMPLETED", type: "MINOR", desc: "Leosin Erantar conosce un passaggio sicuro." },

        // Open - Current Context
        { title: "Esplorare il Castello dei Draghi", status: "IN_PROGRESS", type: "MAJOR", desc: "Il castello nasconde segreti antichi e pericoli." },
        { title: "Identificare l'Anello", status: "OPEN", type: "MINOR", desc: "L'anello trovato sulla strega ha proprietà magiche da studiare." },
        { title: "Vendere il bottino a Waterdeep", status: "OPEN", type: "MINOR", desc: "450 monete d'oro e altri oggetti da liquidare." },

        // Filler for Pagination (6-15)
        { title: "Decifrare la Pergamena di Volo", status: "OPEN", type: "MINOR", desc: "Richiede un check di Arcano." },
        { title: "Riposare alla locanda", status: "Done", type: "MINOR", desc: "Recuperare le forze dopo la battaglia." },
        { title: "Interrogare il prigioniero Goblin", status: "FAILED", type: "MINOR", desc: "Il goblin è scappato durante la notte." },
        { title: "Trovare provviste per il viaggio", status: "OPEN", type: "MINOR", desc: "Le risorse scarseggiano." },
        { title: "Investigare sulle luci nella palude", status: "OPEN", type: "MINOR", desc: "Strani fuochi fatui attirano i viaggiatori." },
        { title: "Riparare l'armatura del Paladino", status: "OPEN", type: "MINOR", desc: "Danneggiata dall'acido del Troll." },
        { title: "Studiare la storia di Nerithar", status: "OPEN", type: "MINOR", desc: "Cercare libri nella biblioteca del castello." },
        { title: "Addestrare il cane da guardia", status: "IN_PROGRESS", type: "MINOR", desc: "Serve tempo e pazienza." },
        { title: "Recuperare l'amuleto perduto", status: "OPEN", type: "MAJOR", desc: "Caduto nel fango durante l'imboscata." }
    ];

    // 4. Insert
    let addedCount = 0;
    for (const q of questsToCheck) {
        // Check if exists
        const existing = db.prepare("SELECT id FROM quests WHERE campaign_id = ? AND title = ?").get(campaign.id, q.title);
        if (!existing) {
            // function addQuest(campaignId: number, title: string, sessionId?: string, description?: string, status?: string, type?: string, isManual?: boolean): number
            const status = q.status === 'Done' ? 'COMPLETED' : q.status;
            addQuest(campaign.id, q.title, session.session_id, q.desc, status, q.type, true);
            console.log(`➕ Added: ${q.title}`);
            addedCount++;
        } else {
            console.log(`🔹 Skipped (Exists): ${q.title}`);
        }
    }

    console.log(`\n✅ Done! Added ${addedCount} quests.`);
};

run().catch(console.error);
