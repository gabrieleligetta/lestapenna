const TITLE_STARTERS = new Set([
    'Dama',
    'Signora',
    'Pallida',
    'Bianca',
    'Nera',
    'Rossa',
    'Regina',
    'Principessa',
    'Principe',
    'Re',
    'Imperatore',
    'Imperatrice',
    'Conte',
    'Contessa',
    'Duca',
    'Duchessa',
    'Madre',
    'Padre',
    'Sorella',
    'Fratello',
    'Santo',
    'Santa'
]);

const LOWER_CONNECTORS = new Set([
    'di',
    'del',
    'della',
    'dei',
    'degli',
    'delle',
    'da',
    'dal',
    'dalla',
    'de',
    'd'
]);

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeComparableName(value: string): string {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanTitleCandidate(raw: string): string | null {
    const words = raw
        .replace(/[.,;:!?].*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);

    const kept: string[] = [];
    for (const word of words) {
        const normalized = word.replace(/[^\p{L}'-]/gu, '');
        const comparable = normalized.toLowerCase().replace(/['-]$/, '');
        const startsUpper = /^\p{Lu}/u.test(normalized);

        if (startsUpper || LOWER_CONNECTORS.has(comparable)) {
            kept.push(normalized);
            if (kept.length >= 5) break;
            continue;
        }
        break;
    }

    while (kept.length > 0 && LOWER_CONNECTORS.has(kept[kept.length - 1].toLowerCase())) {
        kept.pop();
    }

    if (kept.length === 0) return null;
    if (!TITLE_STARTERS.has(kept[0])) return null;

    const capitalizedWords = kept.filter(w => /^\p{Lu}/u.test(w)).length;
    if (capitalizedWords < 2) return null;

    return kept.join(' ');
}

function addUniqueName(names: string[], candidate: string): void {
    const normalizedCandidate = normalizeComparableName(candidate);
    if (!normalizedCandidate) return;
    if (names.some(name => normalizeComparableName(name) === normalizedCandidate)) return;
    names.push(candidate);
}

/**
 * Adds capitalized title/apposition names that the LLM may have collapsed into
 * a neighboring entity, e.g. "Entità mangia-farfalle, la Dama Bianca".
 *
 * This intentionally favors a separate entity over an alias when two distinct
 * capitalized names appear in apposition. Duplicate cleanup can happen later,
 * but a missed entity cannot be recovered from RAG metadata.
 */
export function augmentNpcNamesFromAppositions(text: string, names: string[]): string[] {
    const augmented = [...names];

    for (const name of names) {
        const escapedName = escapeRegExp(name);
        const afterPattern = new RegExp(
            `${escapedName}\\s*,\\s*(?:il|lo|la|l'|Il|Lo|La|L')\\s+([^\\n.?!;:]{2,80})`,
            'giu'
        );

        let match: RegExpExecArray | null;
        while ((match = afterPattern.exec(text)) !== null) {
            const candidate = cleanTitleCandidate(match[1]);
            if (candidate && normalizeComparableName(candidate) !== normalizeComparableName(name)) {
                addUniqueName(augmented, candidate);
            }
        }

        const beforePattern = new RegExp(
            `(?:il|lo|la|l'|Il|Lo|La|L')\\s+([^\\n.?!;:]{2,80})\\s*,\\s*${escapedName}`,
            'giu'
        );

        while ((match = beforePattern.exec(text)) !== null) {
            const candidate = cleanTitleCandidate(match[1]);
            if (candidate && normalizeComparableName(candidate) !== normalizeComparableName(name)) {
                addUniqueName(augmented, candidate);
            }
        }
    }

    return augmented;
}

export function augmentNpcNamesFromKnownMentions(
    text: string,
    names: string[],
    knownNpcs: Array<{ name?: string | null; aliases?: string | null }>
): string[] {
    const augmented = [...names];

    for (const npc of knownNpcs) {
        if (!npc.name) continue;

        const candidates = [
            npc.name,
            ...(npc.aliases || '').split(',').map(alias => alias.trim()).filter(Boolean)
        ];

        if (candidates.some(candidate => containsNameMention(text, candidate))) {
            addUniqueName(augmented, npc.name);
        }
    }

    return augmented;
}

function containsNameMention(text: string, name: string): boolean {
    const escaped = escapeRegExp(name).replace(/\\\s+/g, '\\s+');
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
    return pattern.test(text);
}
