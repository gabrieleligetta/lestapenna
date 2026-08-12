import type { Messages } from '../i18n/messages';
import type { BadgeTone } from './Badge';
import type { IconName } from './icons';

export type StatusKey = keyof Messages['statuses'];

const STATUS_ALIASES: Record<string, StatusKey> = {
    'IN CORSO': 'IN_PROGRESS',
    DONE: 'COMPLETED',
    FALLITA: 'FAILED',
    FUNZIONANTE: 'FUNCTIONAL',
    DISTRUTTO: 'DESTROYED',
    PERDUTO: 'LOST',
    SIGILLATO: 'SEALED',
    DORMIENTE: 'DORMANT',
};

const PRESENTATION: Record<StatusKey, { tone: BadgeTone; icon: IconName }> = {
    OPEN: { tone: 'neutral', icon: 'open' },
    IN_PROGRESS: { tone: 'accent', icon: 'progress' },
    COMPLETED: { tone: 'success', icon: 'check' },
    FAILED: { tone: 'danger', icon: 'failed' },
    ACTIVE: { tone: 'success', icon: 'sparkles' },
    DISBANDED: { tone: 'warning', icon: 'lost' },
    DESTROYED: { tone: 'danger', icon: 'flame' },
    ALIVE: { tone: 'success', icon: 'sparkles' },
    DEAD: { tone: 'danger', icon: 'skull' },
    UNKNOWN: { tone: 'neutral', icon: 'lost' },
    MISSING: { tone: 'warning', icon: 'lost' },
    FUNCTIONAL: { tone: 'success', icon: 'sparkles' },
    LOST: { tone: 'warning', icon: 'lost' },
    SEALED: { tone: 'accent', icon: 'sealed' },
    DORMANT: { tone: 'neutral', icon: 'dormant' },
    DEFEATED: { tone: 'danger', icon: 'skull' },
    FLED: { tone: 'warning', icon: 'lost' },
    ESCAPED: { tone: 'warning', icon: 'lost' },
};

function normalizeStatus(status: string): StatusKey | null {
    const normalized = status.trim().toUpperCase();
    const aliased = STATUS_ALIASES[normalized] ?? normalized;
    return aliased in PRESENTATION ? aliased as StatusKey : null;
}

function fallbackLabel(status: string): string {
    return status
        .trim()
        .toLocaleLowerCase()
        .replaceAll('_', ' ')
        .replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase());
}

export function statusLabel(t: Messages, status: string): string {
    const key = normalizeStatus(status);
    return key ? t.statuses[key] : fallbackLabel(status);
}

export function statusPresentation(status: string): { tone: BadgeTone; icon: IconName } {
    const key = normalizeStatus(status);
    return key ? PRESENTATION[key] : { tone: 'neutral', icon: 'generic' };
}
