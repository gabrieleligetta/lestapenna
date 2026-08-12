/**
 * Canonical format of the persisted summary data (sessions.summary_data
 * and the summary_data.json dumps of the test runs).
 *
 * History: the old format stored 4 fields for 2 real contents —
 * `summary` and `narrative` byte-identical, plus `narrativeBrief` (a
 * concatenated string) AND `narrativeBriefs` (an array), with the "**Atto N**"
 * concatenation logic duplicated in 4 places. The new format is:
 *
 *   { metadata: { title, tone, tokens, generatedAt, acts },
 *     narrative: "<long summary>",
 *     brief: "<short summary>" }
 *
 * Splitting into acts is only an internal device for staying inside the context
 * limits: the per-act briefs are joined here into a single continuous text
 * (no "Atto N" headers), and only metadata.acts keeps a trace of it.
 * parseSummaryData() ALSO reads the old format, so the sessions already
 * in the DB stay readable.
 */

export interface SummaryMetadata {
    title: string;
    tone: string;
    tokens: number;
    /** Epoch ms di generazione. */
    generatedAt: number;
    /** Number of acts (= briefs.length). */
    acts: number;
}

export interface SummaryData {
    metadata: SummaryMetadata;
    /** Long summary (the full narration). */
    narrative: string;
    /** Short summary (a single text, acts already joined). */
    brief: string;
}

/** Length of the fallback brief derived from the narrative (a Discord-friendly limit). */
const FALLBACK_BRIEF_CHARS = 1800;

function fallbackBrief(narrative: string): string {
    return narrative.substring(0, FALLBACK_BRIEF_CHARS) + (narrative.length > FALLBACK_BRIEF_CHARS ? '...' : '');
}

/** Joins the per-act briefs into a continuous text, without betraying the split. */
function joinBriefs(briefs: string[]): string {
    return briefs.filter(b => b && b.trim().length > 0).join('\n\n');
}

/**
 * Builds the canonical format. `briefs` are the short per-act summaries
 * produced by the pipeline (one when the session was not split): they are
 * joined here; without briefs the short one is derived from the narrative.
 */
export function buildSummaryData(params: {
    title: string;
    tone: string;
    tokens: number;
    narrative: string;
    briefs?: string[];
}): SummaryData {
    const briefs = params.briefs?.filter(b => b && b.trim().length > 0) || [];
    return {
        metadata: {
            title: params.title,
            tone: params.tone,
            tokens: params.tokens,
            generatedAt: Date.now(),
            acts: Math.max(briefs.length, 1),
        },
        narrative: params.narrative,
        brief: briefs.length > 0 ? joinBriefs(briefs) : fallbackBrief(params.narrative),
    };
}

/**
 * Normalizes a summary_data read from the DB/a file into the canonical format.
 * It accepts both the new format and the legacy one (flat summary/narrative/
 * narrativeBrief/narrativeBriefs). Returns null when unrecognizable.
 */
export function parseSummaryData(raw: any): SummaryData | null {
    if (!raw || typeof raw !== 'object') return null;

    // Formato nuovo
    if (raw.metadata && typeof raw.narrative === 'string' && typeof raw.brief === 'string') {
        return raw as SummaryData;
    }

    // Formato intermedio (metadata + briefs array, mai andato in prod a lungo)
    if (raw.metadata && typeof raw.narrative === 'string' && Array.isArray(raw.briefs)) {
        return { metadata: raw.metadata, narrative: raw.narrative, brief: joinBriefs(raw.briefs) };
    }

    // Formato legacy
    const narrative: string = raw.narrative || raw.summary || '';
    if (!narrative && !raw.title) return null;

    const briefs: string[] = Array.isArray(raw.narrativeBriefs) && raw.narrativeBriefs.length > 0
        ? raw.narrativeBriefs
        : (raw.narrativeBrief ? [raw.narrativeBrief] : (narrative ? [fallbackBrief(narrative)] : []));

    return {
        metadata: {
            title: raw.title || 'Sessione',
            tone: raw.tone || 'DM',
            tokens: raw.tokens || 0,
            generatedAt: raw.generatedAt || 0,
            acts: Math.max(briefs.length, 1),
        },
        narrative,
        brief: joinBriefs(briefs),
    };
}
