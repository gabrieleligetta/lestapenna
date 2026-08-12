/**
 * VERSION OPTIMIZED FOR WHISPER SEGMENTS
 * Filters hallucinations out of single text segments (timestamps not included)
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

    // === STANDALONE GENERIC PHRASES (only when they are the whole segment) ===
    // Note: "Grazie", "Ok", "Sì", "No" can be legitimate dialogue in D&D.
    // We only filter the longer variants that are typical Whisper hallucinations.
    /^\s*Grazie\s+a\s+(tutti|voi)\.?\s*$/gi,
    /^\s*Grazie\s+per\s+la\s+visione\.?\s*$/gi,
    /^\s*Ah[!.]?\s*$/gi,
    /^\s*Oh[!.]?\s*$/gi,
    /^\s*Mille\.?\s*$/gi,

    // === ALLUCINAZIONI RIPETUTE (Pattern Aggressivi) ===
    /^\s*A\s+tutti\.?\s*$/gi,
    /^\s*A\s+te\.?\s*$/gi,
    /^\s*A\s+voi\.?\s*$/gi,
    /^\s*Agli\s+altri\.?\s*$/gi,
    /A tutti[\.,]?\s*(A tutti[\.,]?\s*)*/gi, // Catches repetitions such as "A tutti. A tutti."
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

    // Apply every pattern
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

// A separate function for whole files (the $teststreaming command)
export function filterTranscriptFile(inputPath: string): { 
    success: boolean; 
    cleaned: string; 
    stats: { removed: number; originalLength: number; cleanedLength: number } 
} {
    try {
        const fs = require('fs');
        const original = fs.readFileSync(inputPath, 'utf-8');
        
        // For whole files, process line by line
        const lines = original.split('\n');
        const cleanedLines = lines.map((line: string) => {
            // If the line has a [00:00] timestamp, extract only the content
            const match = line.match(/^\[\d+:\d+\]\s+(?:\[[\w\s]+\]\s+)?(.+)$/);
            if (match) {
                const content = match[1];
                const filtered = filterWhisperHallucinations(content, false);
                // If the content is empty after filtering, drop the whole line
                if (filtered.length === 0) return '';
                // Otherwise rebuild the line
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
