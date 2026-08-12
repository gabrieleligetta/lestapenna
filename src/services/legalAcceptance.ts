import { db } from '../db/client';

/**
 * Register of the legal document acceptances.
 *
 * Two documents, and **they are not the same thing**:
 *
 *  - the **terms** are a contract, and they are accepted. With the Discord login
 *    already in place, an explicit click is far stronger evidence than a «by
 *    using it you accept» written at the bottom of the page;
 *  - the **privacy notice** is not accepted: under GDPR it is an *information*
 *    duty, not a contract. Making people tick «I accept the notice»
 *    confuses transparency with consent — which here is not even the legal
 *    basis used — and it is a practice the authorities consider unfair.
 *    So an **acknowledgement** is recorded, with a separate checkbox.
 *
 * The register is **append-only**: a new acceptance does not overwrite the
 * previous one. It exists so we can say *what* was accepted and *when*, and an
 * overwritten row would no longer say that.
 *
 * The IP address is not kept: it would be one more personal datum collected to
 * strengthen evidence that the timestamp and the Discord identity already give.
 */

export type LegalDocument = 'terms' | 'privacy';

/**
 * Current version of each document.
 *
 * ⚠️ **It has to be raised when the text changes substantially**, and only then:
 * raising it for a comma shows the modal to everyone again and teaches people to
 * click without reading, which is the opposite of the point.
 */
export const LEGAL_VERSIONS: Record<LegalDocument, string> = {
    // Raised for the uploaded-pictures pass. The terms gained a clause that puts
    // **new obligations on the user** — warranting they hold the rights to what
    // they upload, and holding the operator harmless for what they do not — plus
    // the notice-and-action mechanism a hosting service owes under DSA Article
    // 16. The privacy notice gained a category of data it had never named
    // (uploaded pictures) and their retention. New duties on one side and new
    // data on the other: substantial on both, so both documents go up.
    terms: '2026-08-12',
    privacy: '2026-08-12',
};

export interface LegalStatus {
    document: LegalDocument;
    currentVersion: string;
    /** The version the user accepted, when they have accepted one. */
    acceptedVersion: string | null;
    acceptedAt: number | null;
    /** True when it is missing altogether or the document has changed since. */
    needsAcceptance: boolean;
}

interface AcceptanceRow {
    version: string;
    accepted_at: number;
}

function latest(userId: string, document: LegalDocument): AcceptanceRow | undefined {
    return db.prepare(`
        SELECT version, accepted_at FROM legal_acceptances
        WHERE discord_user_id = ? AND document = ?
        ORDER BY accepted_at DESC LIMIT 1
    `).get(userId, document) as AcceptanceRow | undefined;
}

export function legalStatusFor(userId: string): LegalStatus[] {
    return (Object.keys(LEGAL_VERSIONS) as LegalDocument[]).map(document => {
        const current = LEGAL_VERSIONS[document];
        const row = latest(userId, document);
        return {
            document,
            currentVersion: current,
            acceptedVersion: row?.version ?? null,
            acceptedAt: row?.accepted_at ?? null,
            needsAcceptance: row?.version !== current,
        };
    });
}

/** True when the user still has to accept or re-accept something. */
export function needsLegalAcceptance(userId: string): boolean {
    return legalStatusFor(userId).some(status => status.needsAcceptance);
}

/**
 * Records the acceptance of the **current** versions.
 *
 * The version does not come from the client: the server decides it. Otherwise a
 * caller could declare having accepted a version they never saw, and the
 * register would be worth about as much as a sticky note.
 */
export function recordLegalAcceptance(userId: string, documents: LegalDocument[]): void {
    const now = Date.now();
    const insert = db.prepare(`
        INSERT INTO legal_acceptances (discord_user_id, document, version, accepted_at)
        VALUES (?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
        for (const document of documents) {
            insert.run(userId, document, LEGAL_VERSIONS[document], now);
        }
    });
    tx();
}
