export function isSessionId(str: string): boolean {
    if (!str) return false;
    const clean = str.trim();
    // Regex per UUID v4 (es. efaebb05-af05-4c02-a346-bebe0375eeaa)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Regex per session_...
    const sessionRegex = /^session_[a-zA-Z0-9-]+$/i;
    // Regex per id:...
    const explicitIdRegex = /^id:[a-zA-Z0-9-]+$/i;

    return uuidRegex.test(clean) || sessionRegex.test(clean) || explicitIdRegex.test(clean);
}

export function extractSessionId(str: string): string {
    if (!str) return "";
    let clean = str.trim();
    if (clean.toLowerCase().startsWith('id:')) {
        clean = clean.substring(3);
    }
    return clean;
}
