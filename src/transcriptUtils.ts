import { SessionNote, getUserProfile } from './db';

export interface TranscriptEntry {
    transcription_text: string | null;
    timestamp: number;
    character_name: string | null;
    macro_location?: string | null;
    micro_location?: string | null;
    user_id?: string;
}

export interface ProcessedSession {
    formattedText: string; // Script Teatrale (per Email)
    linearText: string;    // [MM:SS] Nome: Testo (per AI)
}

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
 * Tenta di parsare una stringa JSON (array o oggetto).
 */
function safeJsonParse(input: string): any {
    if (!input) return null;
    
    let cleaned = input.replace(/```json/gi, '').replace(/```/g, '').trim();

    // Cerca array o oggetto
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    // Se sembra un array, diamo priorità a quello
    if (firstBracket !== -1 && lastBracket !== -1) {
         // Se c'è una graffa prima della quadra, potrebbe essere un oggetto che contiene un array, ma qui ci aspettiamo array di segmenti
         if (firstBrace === -1 || firstBracket < firstBrace) {
             cleaned = cleaned.substring(firstBracket, lastBracket + 1);
         } else {
             cleaned = cleaned.substring(firstBrace, lastBrace + 1);
         }
    } else if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    } else {
        // Nessuna struttura JSON evidente
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
    campaignId?: number
): ProcessedSession {
    const segments: FlattenedSegment[] = [];
    
    // Se sessionStartTime è null, usiamo il timestamp del primo transcript come riferimento
    // Se non ci sono transcript, usiamo 0 (o il primo note timestamp)
    let refTime = sessionStartTime;
    if (!refTime && transcripts.length > 0) {
        // Trova il minimo timestamp
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
            // Fallback: testo intero o parsing fallito
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
            text: `[NOTA UTENTE] ${n.content}`,
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
        formattedText: generateFormattedOutput(segments),
        linearText: generateLinearOutput(segments)
    };
}

function formatRelativeTime(absTime: number, refTime: number): string {
    if (refTime <= 0) return "[0:00]";
    const diff = Math.max(0, absTime - refTime);
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `[${mins}:${secs.toString().padStart(2, '0')}]`;
}

function generateFormattedOutput(segments: FlattenedSegment[]): string {
    let output = "";
    let lastHeader = "";

    segments.forEach(seg => {
        const header = `--- ${seg.character} (File: ${seg.fileLabel}) ---`;
        
        if (header !== lastHeader) {
            output += `\n\n${header}\n`;
            lastHeader = header;
        }
        
        output += `${seg.formattedTime} ${seg.text}\n`;
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
                output += `\n--- CAMBIO SCENA: [${seg.macro || "Invariato"}] - [${seg.micro || "Invariato"}] ---\n`;
                lastMacro = seg.macro;
                lastMicro = seg.micro;
            }
        }

        const prefix = seg.type === 'note' ? '📝 ' : '';
        output += `${prefix}${seg.formattedTime} ${seg.character}: ${seg.text}\n`;
    });

    return output.trim();
}
