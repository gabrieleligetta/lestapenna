import type { Messages } from '../i18n/messages';
import type { IconName } from './icons';

type TimelineType = keyof Messages['timeline']['types'];

const TYPE_ALIASES: Record<string, TimelineType> = {
    RELIGIONE: 'RELIGION',
    DISASTRO: 'DISASTER',
};

const TYPE_ICONS: Record<TimelineType, IconName> = {
    WAR: 'war',
    POLITICS: 'politics',
    DISCOVERY: 'discovery',
    CALAMITY: 'calamity',
    DISASTER: 'calamity',
    SUPERNATURAL: 'supernatural',
    RELIGION: 'religion',
    MYTH: 'myth',
    DEATH: 'death',
    BIRTH: 'birth',
    CONSTRUCTION: 'construction',
    GENERIC: 'generic',
};

function normalizeType(type: string | null | undefined): TimelineType | null {
    if (!type) return null;
    const normalized = type.trim().toUpperCase();
    const aliased = TYPE_ALIASES[normalized] ?? normalized;
    return aliased in TYPE_ICONS ? aliased as TimelineType : null;
}

function humanizeType(type: string): string {
    return type
        .trim()
        .toLocaleLowerCase()
        .replaceAll('_', ' ')
        .replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase());
}

export function eventPresentation(t: Messages, type: string | null | undefined): { icon: IconName; label: string } {
    const key = normalizeType(type);
    if (key) return { icon: TYPE_ICONS[key], label: t.timeline.types[key] };
    return { icon: 'generic', label: type ? humanizeType(type) : t.timeline.types.GENERIC };
}
