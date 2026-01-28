
import { db } from '../db/client';

const run = async () => {
    console.log("📝 Updating Quest Description...");

    // Find "Recuperare l'amuleto perduto"
    const quest = db.prepare("SELECT * FROM quests WHERE title LIKE '%Recuperare l''amuleto perduto%'").get() as any;

    if (!quest) {
        console.error("❌ Quest not found.");
        return;
    }

    const longDesc = "Caduto nel fango durante l'imboscata. La zona era buia, illuminata solo dai lampi rapidi della magia e dalle torce tremolanti dei goblin. L'amuleto, un antico cimelio di famiglia con incastonata una pietra di onice nera, è scivolato dalla tasca strappata della tunica proprio mentre il guerriero schivava un fendente mortale. Ora giace sepolto sotto strati di melma e radici marce, in attesa che qualcuno abbastanza coraggioso (o folle) torni a cercarlo tra le creature che infestano ancora quel luogo maledetto. Si dice che la pietra pulsi debolmente quando si avvicina al suo legittimo proprietario, ma potrebbe essere solo una leggenda per spaventare i ladri.";

    db.prepare("UPDATE quests SET description = ? WHERE id = ?").run(longDesc, quest.id);

    console.log(`✅ Updated Quest #${quest.short_id} ("${quest.title}") with LONG description.`);
};

run().catch(console.error);
