export interface SessionRagFragment {
    id: string;
    content: string;
    speaker?: string;
    timestamp?: string;
    score?: number;
}

export interface TranscriptTurn {
    index: number;
    speaker: string;
    content: string;
    location?: string;
    minute?: number;
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .split(/[^a-z0-9#]+/)
        .filter(token => token.length >= 3);
}

export class SessionRagIndex {
    private readonly fragments: SessionRagFragment[];
    private readonly text: string;
    private readonly turns: TranscriptTurn[];
    private readonly locations: string[];

    constructor(text: string, chunkSize: number = 2200, overlap: number = 250) {
        this.fragments = [];
        this.text = text;
        this.turns = [];
        this.locations = [];
        let index = 0;
        let cursor = 0;
        let currentLocation = '';

        const lines = text.split(/\n+/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const locMatch = trimmed.match(/^\[(?:LUOGO|LOCATION):\s*([^\]]+)\]/i);
            if (locMatch) {
                currentLocation = locMatch[1].trim();
                if (!this.locations.includes(currentLocation)) this.locations.push(currentLocation);
                continue;
            }

            const turnMatch = trimmed.match(/^\[t=(\d+)m\]\s*\[([^\]]+)\]:\s*(.*)$/)
                || trimmed.match(/^\[([^\]]+)\]:\s*(.*)$/)
                || trimmed.match(/^([^:\n]{2,40}):\s*(.*)$/);

            if (turnMatch) {
                const hasMinute = turnMatch.length === 4;
                this.turns.push({
                    index: this.turns.length,
                    minute: hasMinute ? Number(turnMatch[1]) : undefined,
                    speaker: (hasMinute ? turnMatch[2] : turnMatch[1]).trim(),
                    content: (hasMinute ? turnMatch[3] : turnMatch[2]).trim(),
                    location: currentLocation || undefined
                });
            }
        }

        while (cursor < text.length) {
            let end = Math.min(cursor + chunkSize, text.length);
            if (end < text.length) {
                const lastBreak = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('.', end));
                if (lastBreak > cursor + chunkSize * 0.55) end = lastBreak + 1;
            }

            const content = text.substring(cursor, end).trim();
            if (content.length > 40) {
                this.fragments.push({ id: `session-${index++}`, content });
            }

            if (end >= text.length) break;
            cursor = Math.max(end - overlap, cursor + 1);
        }
    }

    overview(): any {
        const speakers = new Map<string, number>();
        for (const turn of this.turns) {
            speakers.set(turn.speaker, (speakers.get(turn.speaker) || 0) + 1);
        }
        return {
            chars: this.text.length,
            fragments: this.fragments.length,
            turns: this.turns.length,
            locations: this.locations,
            speakers: Array.from(speakers.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([speaker, turns]) => ({ speaker, turns }))
        };
    }

    search(query: string, limit: number = 5): SessionRagFragment[] {
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return this.fragments.slice(0, limit);

        return this.fragments
            .map(fragment => {
                const contentTokens = new Set(tokenize(fragment.content));
                let score = 0;
                for (const token of queryTokens) {
                    if (contentTokens.has(token)) score += 2;
                    else if (fragment.content.toLowerCase().includes(token)) score += 1;
                }
                return { ...fragment, score };
            })
            .filter(fragment => (fragment.score || 0) > 0)
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, limit);
    }

    windowAround(query: string, chars: number = 5000): string {
        const [top] = this.search(query, 1);
        if (!top) return this.fragments.slice(0, 2).map(f => f.content).join('\n\n').substring(0, chars);
        return top.content.substring(0, chars);
    }

    mentions(query: string, limit: number = 12): any[] {
        const needle = query.toLowerCase();
        if (!needle) return [];

        return this.turns
            .filter(turn => `${turn.speaker} ${turn.content}`.toLowerCase().includes(needle))
            .slice(0, limit)
            .map(turn => ({
                index: turn.index,
                minute: turn.minute,
                speaker: turn.speaker,
                location: turn.location,
                content: turn.content.substring(0, 900)
            }));
    }

    speakerTurns(speaker: string, limit: number = 10): any[] {
        const needle = speaker.toLowerCase();
        return this.turns
            .filter(turn => turn.speaker.toLowerCase().includes(needle))
            .slice(0, limit)
            .map(turn => ({
                index: turn.index,
                minute: turn.minute,
                location: turn.location,
                content: turn.content.substring(0, 900)
            }));
    }

    locationsInOrder(): string[] {
        return [...this.locations];
    }

    candidateNames(limit: number = 60): string[] {
        const stop = new Set(['Sei', 'Sono', 'Allora', 'Perche', 'Quando', 'Dove', 'Come', 'Non', 'Siamo', 'Avete', 'Hai', 'Ok']);
        const counts = new Map<string, number>();
        const matches = this.text.match(/\b[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ']{2,}(?:\s+[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ']{2,}){0,2}\b/g) || [];
        for (const match of matches) {
            const cleaned = match.replace(/\s+/g, ' ').trim();
            if (stop.has(cleaned)) continue;
            counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
        }
        return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([name, count]) => `${name} (${count})`);
    }
}
