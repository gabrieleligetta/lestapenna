
import { cleanEntityName, levenshteinSimilarity } from '../src/bard/helpers';
import { normalizeLocationNames } from '../src/bard/reconciliation/location';

console.log("=== VERIFICATION SCRIPT: Atlas Cleanup & Reconciliation ===\n");

// 1. Verify cleanEntityName logic (re-run to ensure stability)
console.log("--- 1. Cleaning Tests ---");
const testCases = [
    { in: "Dominio di Ogma - Palazzo (Sala)", expName: "Dominio di Ogma - Palazzo", expExtra: "Sala" },
    { in: "Nuova Arkosia", expName: "Nuova Arkosia", expExtra: null }
];

testCases.forEach(tc => {
    const cleaned = cleanEntityName(tc.in);
    const pass = cleaned.name === tc.expName && cleaned.extra === tc.expExtra;
    console.log(`Input: "${tc.in}" -> Name: "${cleaned.name}", Extra: "${cleaned.extra}" [${pass ? "PASS" : "FAIL"}]`);
});
console.log("");

// 2. Verify Full Path Logic (Mirroring implementation)
console.log("--- 2. Reconciliation Logic Simulation ---");

function simulateReconciliation(newLoc: any, existingLoc: any) {
    // Basic cleanup logic from IngestionService
    const cleanMacro = cleanEntityName(newLoc.macro).name.toLowerCase();
    const cleanMicro = cleanEntityName(newLoc.micro).name.toLowerCase();

    const entryMacro = cleanEntityName(existingLoc.macro).name.toLowerCase();
    const entryMicro = cleanEntityName(existingLoc.micro).name.toLowerCase();

    // 1. Component Similarity
    const macroSim = levenshteinSimilarity(cleanMacro, entryMacro);
    const microSim = levenshteinSimilarity(cleanMicro, entryMicro);
    const combined = (macroSim * 0.4) + (microSim * 0.6);

    console.log(`   Component Sim: ${combined.toFixed(2)} (Macro: ${macroSim.toFixed(2)}, Micro: ${microSim.toFixed(2)})`);

    // 2. Full Path Similarity (Implemented in location.ts)
    const fullPathNew = `${cleanMacro} - ${cleanMicro}`;
    const fullPathEntry = `${entryMacro} - ${entryMicro}`;
    const fullSim = levenshteinSimilarity(fullPathNew, fullPathEntry);

    console.log(`   Full Path Sim: ${fullSim.toFixed(2)}`);
    console.log(`   > Match candidate if Combined > 0.55 OR FullPath > 0.85`);

    return (combined > 0.55 || fullSim > 0.85);
}

const scenarios = [
    {
        name: "Different Split Point",
        new: { macro: "Region - City", micro: "District" },
        existing: { macro: "Region", micro: "City - District" }
    },
    {
        name: "Preposition Difference",
        new: { macro: "Palazzo", micro: "Sala del Trono" },
        existing: { macro: "Palazzo", micro: "Sala al Trono" }
    },
    {
        name: "User Example 1",
        new: { macro: "Dominio di Ogma", micro: "Palazzo centrale - Sala del cerchio di trasporto" },
        existing: { macro: "Dominio di Ogma - Palazzo centrale", micro: "Sala con cerchio di trasporto" }
    }
];

scenarios.forEach(s => {
    console.log(`Scenario: ${s.name}`);
    const isCandidate = simulateReconciliation(s.new, s.existing);
    console.log(`   Result: ${isCandidate ? "CANDIDATE FOUND ✅" : "NO MATCH ❌"}\n`);
});
