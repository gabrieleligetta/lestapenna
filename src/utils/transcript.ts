import { SessionNote, getUserProfile } from '../db';

export interface TranscriptEntry {
    transcription_text: string | null;
    timestamp: number;
    character_name: string | null;
    macro_location?: string | null;
    micro_location?: string | null;
    user_id?: string;
}

// Segmento processato (esportato per Narrative Filter)
export interface ProcessedSegment {
    absoluteTime: number;
    text: string;
    character: string;
    fileLabel: string;
    formattedTime: string;
    type: 'audio' | 'note';
    macro?: string | null;
    micro?: string | null;
}

export interface ProcessedSession {
    formattedText: string; // Script Teatrale (per Email)
    linearText: string;    // [MM:SS] Name: Text (for the AI)
    segments: ProcessedSegment[]; // Segmenti raw per Narrative Filter
}

// Alias interno per compatibilità
interface FlattenedSegment {
    absoluteTime: number;
    text: string;
    character: string;
    fileLabel: string;
    formattedTime: string;
    type: 'audio' | 'note';
    macro?: string | null;
    micro?: string | null;
}

/**
 * Tries to parse a JSON string (array or object).
 */
export function safeJsonParse(input: string): any {
    if (!input) return null;

    let cleaned = input.replace(/```json/gi, '').replace(/```/g, '').trim();

    // Look for an array or an object
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    // Se sembra un array, diamo priorità a quello
    if (firstBracket !== -1 && lastBracket !== -1) {
        // A brace before the bracket could mean an object containing an array, but here we expect an array of segments
        if (firstBrace === -1 || firstBracket < firstBrace) {
            cleaned = cleaned.substring(firstBracket, lastBracket + 1);
        } else {
            cleaned = cleaned.substring(firstBrace, lastBrace + 1);
        }
    } else if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    } else {
        // No obvious JSON structure
        return null;
    }

    try {
        return JSON.parse(cleaned);
    } catch (e) {
        try {
            // Tentativi di riparazione base
            let fixed = cleaned.replace(/\s*\/\/.*$/gm, ''); // Rimuovi commenti
            fixed = fixed.replace(/,\s*([\]}])/g, '$1'); // Rimuovi trailing commas
            return JSON.parse(fixed);
        } catch (e2) {
            return null;
        }
    }
}

export function processChronologicalSession(
    transcripts: TranscriptEntry[],
    notes: SessionNote[],
    sessionStartTime: number | null,
    campaignId?: number,
    compact: boolean = false
): ProcessedSession {
    const segments: FlattenedSegment[] = [];

    // If sessionStartTime is null, use the first transcript's timestamp as the reference
    // If there are no transcripts, use 0 (or the first note timestamp)
    let refTime = sessionStartTime;
    if (!refTime && transcripts.length > 0) {
        // Find the earliest timestamp
        refTime = Math.min(...transcripts.map(t => t.timestamp));
    }
    if (!refTime && notes.length > 0) {
        refTime = Math.min(...notes.map(n => n.timestamp));
    }
    if (!refTime) refTime = 0;

    // 1. Process Transcripts
    for (const t of transcripts) {
        const fileLabel = new Date(t.timestamp).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const charName = t.character_name || 'Sconosciuto';

        // Tenta parsing JSON
        let parsed = safeJsonParse(t.transcription_text || "");

        if (Array.isArray(parsed)) {
            // È un array di segmenti
            parsed.forEach((s: any) => {
                const segmentStart = typeof s.start === 'number' ? s.start : 0;
                const absTime = t.timestamp + Math.floor(segmentStart * 1000);

                segments.push({
                    absoluteTime: absTime,
                    text: s.text || "",
                    character: charName,
                    fileLabel: fileLabel,
                    formattedTime: formatRelativeTime(absTime, refTime!),
                    type: 'audio',
                    macro: t.macro_location,
                    micro: t.micro_location
                });
            });
        } else {
            // Fallback: the whole text, or parsing failed
            const textContent = typeof parsed === 'string' ? parsed : (t.transcription_text || "[Nessun testo]");
            segments.push({
                absoluteTime: t.timestamp,
                text: textContent,
                character: charName,
                fileLabel: fileLabel,
                formattedTime: formatRelativeTime(t.timestamp, refTime!),
                type: 'audio',
                macro: t.macro_location,
                micro: t.micro_location
            });
        }
    }

    // 2. Process Notes
    for (const n of notes) {
        let authorName = "Giocatore";
        if (campaignId && n.user_id) {
            const profile = getUserProfile(n.user_id, campaignId);
            if (profile.character_name) authorName = profile.character_name;
        }

        segments.push({
            absoluteTime: n.timestamp,
            text: `[USER NOTE] ${n.content}`,
            character: authorName,
            fileLabel: "Nota",
            formattedTime: formatRelativeTime(n.timestamp, refTime!),
            type: 'note',
            macro: n.macro_location,
            micro: n.micro_location
        });
    }

    // 3. Sort
    segments.sort((a, b) => a.absoluteTime - b.absoluteTime);

    // 4. Generate Outputs
    return {
        formattedText: generateFormattedOutput(segments, compact),
        linearText: generateLinearOutput(segments),
        segments: segments as ProcessedSegment[] // Per Narrative Filter
    };
}

export function formatRelativeTime(absTime: number, refTime: number): string {
    if (refTime <= 0) return "[00:00]";
    const diff = Math.max(0, absTime - refTime);

    const totalSeconds = Math.floor(diff / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
        return `[${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
    } else {
        return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
    }
}

function generateFormattedOutput(segments: FlattenedSegment[], compact: boolean = false): string {
    let output = "";
    let lastHeader = "";

    segments.forEach(seg => {
        const header = `--- ${seg.character} (File: ${seg.fileLabel}) ---`;

        if (header !== lastHeader) {
            output += `\n\n${header}\n`;
            lastHeader = header;
        }

        if (compact) {
            output += `${seg.formattedTime} ${seg.text}`;
        } else {
            output += `${seg.formattedTime} ${seg.text}\n`;
        }
    });

    return output.trim();
}

function generateLinearOutput(segments: FlattenedSegment[]): string {
    let output = "";
    let lastMacro: string | null | undefined = null;
    let lastMicro: string | null | undefined = null;

    segments.forEach(seg => {
        // Marker cambio scena
        if (seg.type === 'audio' && (seg.macro !== lastMacro || seg.micro !== lastMicro)) {
            if (seg.macro || seg.micro) {
                output += `\n--- SCENE CHANGE: [${seg.macro || "Unchanged"}] - [${seg.micro || "Unchanged"}] ---\n`;
                lastMacro = seg.macro;
                lastMicro = seg.micro;
            }
        }

        const prefix = seg.type === 'note' ? '📝 ' : '';
        // MODIFICA: Usa la pulizia aggressiva
        const cleanText = cleanTranscriptForNarrative(seg.text);
        if (cleanText.length > 1) { // Ignora righe vuote o rumore (min 2 chars)
            // Script format: NAME: Line (no timestamps, to save tokens and keep focus on the story)
            output += `${prefix}${seg.character.toUpperCase()}: ${cleanText}\n\n`;
        }
    });

    return output.trim();
}

/**
 * Aggressively cleans the text by removing JSON artifacts and timestamps.
 * Returns a pure script format for maximum narrative quality.
 */
export function cleanTranscriptForNarrative(text: string): string {
    if (!text) return "";

    // 1. If it is already clean, return
    if (!text.trim().startsWith('[') && !text.includes('"text":')) return text;

    // 2. Tenta parsing JSON robusto
    try {
        // Removes any markdown wrapper or stray characters at the start/end
        let cleaner = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaner);

        if (Array.isArray(parsed)) {
            return parsed
                .map((p: any) => p.text ? p.text.trim() : "")
                .filter((t: any) => t.length > 0)
                .join(" ");
        } else if (typeof parsed === 'object' && parsed.text) {
            return parsed.text;
        }
    } catch (e) {
        // 3. LAST-RESORT FALLBACK (regex) when the JSON is broken
        // Look for "text": "content" patterns and ignore the rest
        const regex = /"text"\s*:\s*"([^"]*)"/g;
        let match;
        let result = [];
        while ((match = regex.exec(text)) !== null) {
            result.push(match[1]);
        }
        if (result.length > 0) return result.join(" ");
    }

    // If everything fails, return the text but try to strip the outer braces
    return text;
}
