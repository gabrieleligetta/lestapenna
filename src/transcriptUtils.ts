import { SessionNote } from './db';

export interface RawTranscript {
    transcription_text: string;
    user_id: string;
    timestamp: number;
    character_name: string | null;
    macro_location?: string | null;
    micro_location?: string | null;
    present_npcs?: string | null;
    filename?: string;
}

export interface EnrichedSessionNote extends SessionNote {
    authorName?: string;
}

export interface FlattenedSegment {
    absoluteTime: number;
    text: string;
    character: string;
    sourceLabel: string; // "File: HH:MM:SS" o "NOTA UTENTE"
    type: 'audio' | 'note';
    macro?: string | null;
    micro?: string | null;
    formattedTime: string; // [MM:SS]
}

export interface ChronologicalSessionOutput {
    segments: FlattenedSegment[];
    formattedText: string; // Stile Script Teatrale (Email)
    linearText: string;    // Stile Lineare (AI)
}

/**
 * Tenta di parsare JSON sporco.
 */
export function safeJsonParse(input: string): any {
    if (!input) return null;
    let cleaned = input.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    // Estrazione chirurgica
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    const lastBrace = cleaned.lastIndexOf('}');
    const lastBracket = cleaned.lastIndexOf(']');

    // Determina se è oggetto o array
    let start = -1;
    let end = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        start = firstBrace;
        end = lastBrace;
    } else if (firstBracket !== -1) {
        start = firstBracket;
        end = lastBracket;
    }

    if (start !== -1 && end !== -1) {
        cleaned = cleaned.substring(start, end + 1);
    } else {
        // Nessuna struttura JSON valida trovata
        return null;
    }

    try {
        return JSON.parse(cleaned);
    } catch (e) {
        try {
            // Tentativi di riparazione comuni
            let fixed = cleaned.replace(/\s*\/\/.*$/gm, ''); // Rimuovi commenti
            fixed = fixed.replace(/,\s*([\]}])/g, '$1'); // Rimuovi trailing commas
            return JSON.parse(fixed);
        } catch (e2) {
            return null;
        }
    }
}

export function processChronologicalSession(
    transcripts: RawTranscript[],
    notes: EnrichedSessionNote[],
    sessionStartTime: number | null
): ChronologicalSessionOutput {
    const segments: FlattenedSegment[] = [];
    const refTime = sessionStartTime || (transcripts.length > 0 ? transcripts[0].timestamp : 0);

    // 1. Processa Transcript Audio
    for (const t of transcripts) {
        const charName = t.character_name || 'Sconosciuto';
        const fileLabel = new Date(t.timestamp).toLocaleTimeString('it-IT');
        
        let parsed = safeJsonParse(t.transcription_text);
        
        // Se è un array, appiattisci i segmenti
        if (Array.isArray(parsed)) {
            parsed.forEach((s: any) => {
                const absTime = t.timestamp + (Math.floor((s.start || 0) * 1000));
                segments.push(createSegment(absTime, s.text, charName, `File: ${fileLabel}`, 'audio', refTime, t.macro_location, t.micro_location));
            });
        } else {
            // Fallback: testo intero o nullo
            if (t.transcription_text) {
                segments.push(createSegment(t.timestamp, t.transcription_text, charName, `File: ${fileLabel}`, 'audio', refTime, t.macro_location, t.micro_location));
            }
        }
    }

    // 2. Processa Note Utente
    for (const n of notes) {
        const charName = n.authorName || "Giocatore";
        segments.push(createSegment(n.timestamp, n.content, charName, "NOTA UTENTE", 'note', refTime, n.macro_location, n.micro_location));
    }

    // 3. Ordina
    segments.sort((a, b) => a.absoluteTime - b.absoluteTime);

    // 4. Genera Output Formattati
    const formattedText = generateFormattedText(segments);
    const linearText = generateLinearText(segments);

    return { segments, formattedText, linearText };
}

function createSegment(
    absTime: number, 
    text: string, 
    character: string, 
    sourceLabel: string, 
    type: 'audio' | 'note', 
    refTime: number,
    macro?: string | null,
    micro?: string | null
): FlattenedSegment {
    const diff = Math.max(0, absTime - refTime);
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    const formattedTime = `[${mins}:${secs.toString().padStart(2, '0')}]`;

    return {
        absoluteTime: absTime,
        text: (text || "").trim(),
        character,
        sourceLabel,
        type,
        macro,
        micro,
        formattedTime
    };
}

function generateFormattedText(segments: FlattenedSegment[]): string {
    let output = "";
    let lastHeader = "";

    segments.forEach(seg => {
        const header = `--- ${seg.character} (${seg.sourceLabel}) ---`;
        
        // Se cambia la fonte o l'interlocutore, ristampa l'header
        if (header !== lastHeader) {
            output += `\n\n${header}\n`;
            lastHeader = header;
        }
        
        const prefix = seg.type === 'note' ? '📝 ' : '';
        output += `${seg.formattedTime} ${prefix}${seg.text}\n`;
    });

    return output.trim();
}

function generateLinearText(segments: FlattenedSegment[]): string {
    let output = "";
    let lastMacro: string | null | undefined = null;
    let lastMicro: string | null | undefined = null;

    segments.forEach(seg => {
        // Marker cambio scena (solo per audio, le note seguono il flusso)
        if (seg.type === 'audio' && (seg.macro !== lastMacro || seg.micro !== lastMicro)) {
            if (seg.macro || seg.micro) {
                output += `\n--- CAMBIO SCENA: [${seg.macro || "Invariato"}] - [${seg.micro || "Invariato"}] ---\n`;
                lastMacro = seg.macro;
                lastMicro = seg.micro;
            }
        }

        const prefix = seg.type === 'note' ? '📝 [NOTA UTENTE] ' : '';
        output += `${seg.formattedTime} ${prefix}${seg.character}: ${seg.text}\n`;
    });

    return output.trim();
}
