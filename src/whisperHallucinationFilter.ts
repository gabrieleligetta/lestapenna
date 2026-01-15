/**
 * VERSIONE OTTIMIZZATA PER SEGMENTI WHISPER
 * Filtra allucinazioni da singoli segmenti di testo (non timestamp inclusi)
 */

const HALLUCINATION_PATTERNS = [
    // === SOTTOTITOLI ===
    /Sottotitoli\s+creati\s+dalla\s+comunit[àa]\s+(di\s+)?Amara\.org\.?/gi,
    /\[?Sottotitoli(\s+e\s+revisione)?\s+(:)?\s+(a\s+cura\s+)?di\s+[A-Za-z\s]+\]?/gi,
    /Sottotitoli:\s+Luca\s+Gardella/gi,
    /Sottotitoli\s+e\s+revisione\s+a\s+cura\s+di\s+QTSS/gi,
    /Autore\s+dei(\s+sottotitoli)?/gi,
    /Sottotitoli\s+di/gi,
    /Sottotitoli.*/gi, // Catch-all per qualsiasi variante

    // === MARCATORI AUDIO ===
    /^\s*\[?SILENZIO\]?\s*$/gi,
    /^\s*\[?Silenzio\]?\s*$/gi,
    /^\s*\[?risate?\]?\s*$/gi,
    /^\s*\*risate?\*\s*$/gi,
    /^\s*Risate?\.?\s*$/gi,
    /^\s*\[?Musica\]?\s*$/gi,
    /^\s*\[?SIGLA\]?\s*$/gi,
    /^\s*\[?sigla\]?\s*$/gi,
    /^\s*\[?sospiro\]?\s*$/gi,
    /^\s*\[?tossisce\]?\s*$/gi,
    /^\s*\[?sussurro\]?\s*$/gi,

    // === FRASI GENERICHE STANDALONE (solo se segmento intero) ===
    /^\s*Grazie\.?\s*$/gi,
    /^\s*Ok\.?\s*$/gi,
    /^\s*S[ìi]\.?\s*$/gi,
    /^\s*No\.?\s*$/gi,
    /^\s*Grazie\s+a\s+(tutti|voi)\.?\s*$/gi,
    /^\s*Ah[!.]?\s*$/gi,
    /^\s*Oh[!.]?\s*$/gi,
    /^\s*Mille\.?\s*$/gi,
    /^\s*Ciao\.?\s*$/gi,

    // === ALLUCINAZIONI RIPETUTE (Pattern Aggressivi) ===
    /^\s*A\s+tutti\.?\s*$/gi,
    /^\s*A\s+te\.?\s*$/gi,
    /^\s*A\s+voi\.?\s*$/gi,
    /^\s*Agli\s+altri\.?\s*$/gi,
    /A tutti[\.,]?\s*(A tutti[\.,]?\s*)*/gi, // Cattura ripetizioni "A tutti. A tutti."
    /A te[\.,]?\s*(A te[\.,]?\s*)*/gi,
    /A voi[\.,]?\s*(A voi[\.,]?\s*)*/gi,

    // === ALLUCINAZIONI SPECIFICHE (Italiano) ===
    /Concentrazione\s+di\s+Chieti/gi,
    /Noblesse\s+anatema/gi,
    /Salomando/gi,
    /Autore dei.*/gi,

    // === LOOPING ===
    /(\b\w{4,}\b)(\s+\1){3,}/gi,

    // === YOUTUBE ===
    /Thanks?\s+for\s+(watching|listening)/gi,
    /Subtitles\s+by\s+the\s+Amara\.org\s+community/gi,
];

export function filterWhisperHallucinations(text: string, logStats = false): string {
    if (!text || text.trim().length === 0) return '';
    
    let cleaned = text;
    let removedCount = 0;

    // Applica tutti i pattern
    for (const pattern of HALLUCINATION_PATTERNS) {
        const before = cleaned;
        cleaned = cleaned.replace(pattern, '');
        if (before !== cleaned) removedCount++;
    }

    // Pulizia spazi
    cleaned = cleaned
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned;
}

// Funzione separata per file completi (comando $teststreaming)
export function filterTranscriptFile(inputPath: string): { 
    success: boolean; 
    cleaned: string; 
    stats: { removed: number; originalLength: number; cleanedLength: number } 
} {
    try {
        const fs = require('fs');
        const original = fs.readFileSync(inputPath, 'utf-8');
        
        // Per file completi, processa riga per riga
        const lines = original.split('\n');
        const cleanedLines = lines.map((line: string) => {
            // Se la riga ha timestamp [00:00], estrai solo il contenuto
            const match = line.match(/^\[\d+:\d+\]\s+(?:\[[\w\s]+\]\s+)?(.+)$/);
            if (match) {
                const content = match[1];
                const filtered = filterWhisperHallucinations(content, false);
                // Se il contenuto è vuoto dopo filtro, rimuovi tutta la riga
                if (filtered.length === 0) return '';
                // Altrimenti ricostruisci la riga
                return line.replace(content, filtered);
            }
            return line;
        }).filter((line: { trim: () => { (): any; new(): any; length: number; }; }) => line.trim().length > 0);

        const cleaned = cleanedLines.join('\n');
        
        const stats = {
            removed: lines.length - cleanedLines.length,
            originalLength: original.length,
            cleanedLength: cleaned.length
        };

        return { success: true, cleaned, stats };
    } catch (e) {
        console.error('[HallucinationFilter] Errore:', e);
        return { 
            success: false, 
            cleaned: '', 
            stats: { removed: 0, originalLength: 0, cleanedLength: 0 } 
        };
    }
}
