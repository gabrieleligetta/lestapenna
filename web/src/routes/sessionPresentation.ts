export function formatSessionTimestamp(
    timestamp: number | null,
    locale: string,
    includeTime = false,
): string {
    if (!timestamp) return '—';
    const milliseconds = timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp;
    return new Intl.DateTimeFormat(locale, {
        dateStyle: 'long',
        ...(includeTime ? { timeStyle: 'short' as const } : {}),
    }).format(new Date(milliseconds));
}
