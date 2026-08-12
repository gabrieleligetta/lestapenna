import { db } from '../client';
import {
    Secret,
    secretVault,
    SecretVaultError,
    type SecretIdentity,
    type SecretScope,
} from '../../services/secretVault';

/**
 * Per-tenant credentials, encrypted at rest.
 *
 * Redaction is structural, not a convention: `getMeta()` cannot return a
 * plaintext value because it does not even read one, and `getDecrypted()` is
 * the only route to plaintext. The API module imports only the former; no
 * endpoint exposes a secret's value, and writing happens only in `PUT`.
 */

/**
 * Outcome of a credential's last verification.
 *
 * `QUOTA_EXHAUSTED` is deliberately distinct from `AUTH_FAILED`: a key with no
 * credit is perfectly valid, and telling the user it is "invalid" would send
 * them to regenerate it instead of topping up. It is also the only reliable way
 * we have of reporting exhausted credit, since no provider exposes the
 * remaining balance to an ordinary API key.
 */
export type SecretVerifyStatus =
    | 'OK'
    | 'AUTH_FAILED'
    | 'QUOTA_EXHAUSTED'
    | 'UNREACHABLE'
    | 'UNDECRYPTABLE';

/** What can be shown about a credential without revealing it. */
export interface TenantSecretMeta {
    scope: SecretScope;
    scopeId: string;
    secretKey: string;
    /** The last 4 characters, to recognize it in the UI. */
    hint: string | null;
    keyVersion: number;
    createdAt: number;
    updatedAt: number;
    updatedBy: string | null;
    lastVerifiedAt: number | null;
    verifyStatus: SecretVerifyStatus | null;
    verifyError: string | null;
}

interface SecretRow {
    scope: SecretScope;
    scope_id: string;
    secret_key: string;
    ciphertext: Buffer;
    iv: Buffer;
    auth_tag: Buffer;
    key_version: number;
    fingerprint: string;
    hint: string | null;
    created_at: number;
    updated_at: number;
    updated_by: string | null;
    last_verified_at: number | null;
    verify_status: SecretVerifyStatus | null;
    verify_error: string | null;
}

function toMeta(row: SecretRow): TenantSecretMeta {
    return {
        scope: row.scope,
        scopeId: row.scope_id,
        secretKey: row.secret_key,
        hint: row.hint,
        keyVersion: row.key_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        lastVerifiedAt: row.last_verified_at,
        verifyStatus: row.verify_status,
        verifyError: row.verify_error,
    };
}

const SELECT_META = `
    SELECT scope, scope_id, secret_key, key_version, fingerprint, hint,
           created_at, updated_at, updated_by,
           last_verified_at, verify_status, verify_error
    FROM tenant_secrets
`;

export const tenantSecretsRepository = {
    /** Metadata of every credential in a scope. Never the value. */
    listMeta(scope: SecretScope, scopeId: string): TenantSecretMeta[] {
        const rows = db.prepare(
            `${SELECT_META} WHERE scope = ? AND scope_id = ? ORDER BY secret_key`,
        ).all(scope, scopeId) as SecretRow[];
        return rows.map(toMeta);
    },

    getMeta(identity: SecretIdentity): TenantSecretMeta | undefined {
        const row = db.prepare(
            `${SELECT_META} WHERE scope = ? AND scope_id = ? AND secret_key = ?`,
        ).get(identity.scope, identity.scopeId, identity.secretKey) as SecretRow | undefined;
        return row ? toMeta(row) : undefined;
    },

    /**
     * Stores a credential, replacing any previous one.
     *
     * Fails when the vault is not configured: without a master key the only
     * alternative would be writing the key in clear text, which is exactly what
     * this module exists to protect against.
     */
    put(identity: SecretIdentity, plaintext: string, updatedBy: string | null = null): void {
        const trimmed = plaintext.trim();
        if (!trimmed) throw new Error('Una credenziale vuota non ha senso da salvare.');

        const encrypted = secretVault.encrypt(identity, trimmed);
        const now = Date.now();
        db.prepare(`
            INSERT INTO tenant_secrets (
                scope, scope_id, secret_key, ciphertext, iv, auth_tag, key_version,
                fingerprint, hint, created_at, updated_at, updated_by,
                last_verified_at, verify_status, verify_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
            ON CONFLICT(scope, scope_id, secret_key) DO UPDATE SET
                ciphertext = excluded.ciphertext,
                iv = excluded.iv,
                auth_tag = excluded.auth_tag,
                key_version = excluded.key_version,
                fingerprint = excluded.fingerprint,
                hint = excluded.hint,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by,
                last_verified_at = NULL,
                verify_status = NULL,
                verify_error = NULL
        `).run(
            identity.scope, identity.scopeId, identity.secretKey,
            encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion,
            encrypted.fingerprint, encrypted.hint, now, now, updatedBy,
        );
    },

    remove(identity: SecretIdentity): boolean {
        const result = db.prepare(
            'DELETE FROM tenant_secrets WHERE scope = ? AND scope_id = ? AND secret_key = ?',
        ).run(identity.scope, identity.scopeId, identity.secretKey);
        return result.changes > 0;
    },

    /**
     * The only access to the plaintext value. Reserved for the AI layer.
     *
     * A row that fails to decrypt is marked `UNDECRYPTABLE` and kept: the UI
     * will ask for the key to be re-entered. Deleting it would make a
     * recoverable configuration mistake irreversible.
     */
    getDecrypted(identity: SecretIdentity): Secret | null {
        const row = db.prepare(`
            SELECT ciphertext, iv, auth_tag, key_version
            FROM tenant_secrets WHERE scope = ? AND scope_id = ? AND secret_key = ?
        `).get(identity.scope, identity.scopeId, identity.secretKey) as
            | Pick<SecretRow, 'ciphertext' | 'iv' | 'auth_tag' | 'key_version'>
            | undefined;
        if (!row) return null;

        const secret = secretVault.decrypt(identity, {
            ciphertext: row.ciphertext,
            iv: row.iv,
            authTag: row.auth_tag,
            keyVersion: row.key_version,
        });

        if (!secret) {
            console.warn(
                `[SecretVault] ${identity.scope}:${identity.scopeId} chiave=${identity.secretKey} ` +
                `non decifrabile (versione ${row.key_version}): reinserirla dalle impostazioni.`,
            );
            tenantSecretsRepository.markVerification(
                identity, 'UNDECRYPTABLE', 'La master key attuale non decifra questa credenziale.',
            );
        }
        return secret;
    },

    markVerification(
        identity: SecretIdentity,
        status: SecretVerifyStatus,
        error: string | null = null,
    ): void {
        db.prepare(`
            UPDATE tenant_secrets
            SET last_verified_at = ?, verify_status = ?, verify_error = ?
            WHERE scope = ? AND scope_id = ? AND secret_key = ?
        `).run(Date.now(), status, error, identity.scope, identity.scopeId, identity.secretKey);
    },

    /**
     * Re-encrypts every row with the active master key.
     *
     * Rows the current key cannot open are counted and left intact: a partial
     * rotation can be recovered from by putting the old key back in the
     * environment, a destructive one cannot.
     */
    rotateAll(): { rotated: number; skipped: number; alreadyCurrent: number } {
        const target = secretVault.activeKeyVersion();
        if (target === null) {
            throw new SecretVaultError('VAULT_UNAVAILABLE', 'Nessuna master key configurata.');
        }

        const rows = db.prepare(`
            SELECT scope, scope_id, secret_key, ciphertext, iv, auth_tag, key_version
            FROM tenant_secrets
        `).all() as SecretRow[];

        let rotated = 0;
        let skipped = 0;
        let alreadyCurrent = 0;

        const apply = db.transaction((row: SecretRow) => {
            const identity: SecretIdentity = {
                scope: row.scope, scopeId: row.scope_id, secretKey: row.secret_key,
            };
            const secret = secretVault.decrypt(identity, {
                ciphertext: row.ciphertext,
                iv: row.iv,
                authTag: row.auth_tag,
                keyVersion: row.key_version,
            });
            if (!secret) {
                skipped += 1;
                return;
            }
            const encrypted = secretVault.encrypt(identity, secret.reveal());
            db.prepare(`
                UPDATE tenant_secrets
                SET ciphertext = ?, iv = ?, auth_tag = ?, key_version = ?, updated_at = ?
                WHERE scope = ? AND scope_id = ? AND secret_key = ?
            `).run(
                encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion,
                Date.now(), row.scope, row.scope_id, row.secret_key,
            );
            rotated += 1;
        });

        for (const row of rows) {
            if (row.key_version === target) {
                alreadyCurrent += 1;
                continue;
            }
            apply(row);
        }

        return { rotated, skipped, alreadyCurrent };
    },
};
