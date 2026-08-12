import * as crypto from 'crypto';
import * as util from 'util';

/**
 * Per-tenant secret vault.
 *
 * Under BYOK every table entrusts its own provider keys to Lestapenna.
 * That is somebody else's money: they have to be encrypted at rest, because the SQLite
 * database is replicated off-host by Litestream and a backup that fell into the
 * wrong hands must not contain a single readable key.
 *
 * ⚠️ `SECRETS_MASTER_KEY` must not live in the same bucket as the Litestream
 * replica, nor under `data/`: that would be like leaving the key in the lock.
 */

const HKDF_INFO = 'lestapenna.tenant-secret.v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export type SecretScope = 'guild' | 'campaign';

export interface EncryptedSecret {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    keyVersion: number;
    /** sha256 of the plaintext, first 16 hex chars: it only serves to detect a change. */
    fingerprint: string;
    /** The last 4 characters, so the key can be recognized in the UI. */
    hint: string;
}

export interface SecretIdentity {
    scope: SecretScope;
    scopeId: string;
    secretKey: string;
}

/**
 * A plaintext secret that cannot end up in a log by oversight.
 *
 * The value lives in a private field and the three realistic escape routes —
 * template literal, `console.log`, `JSON.stringify`/`res.send` — are closed
 * by construction rather than by discipline. `reveal()` is to be called in a single
 * place in the application, when the SDK client is built, so the audit is a
 * grep.
 */
export class Secret {
    readonly #value: string;

    constructor(value: string) {
        this.#value = value;
    }

    reveal(): string {
        return this.#value;
    }

    toString(): string {
        return 'Secret(***)';
    }

    toJSON(): string {
        return '***';
    }

    [util.inspect.custom](): string {
        return 'Secret(***)';
    }
}

export class SecretVaultError extends Error {
    constructor(readonly code: 'VAULT_UNAVAILABLE' | 'UNDECRYPTABLE', message: string) {
        super(message);
        this.name = 'SecretVaultError';
    }
}

function parseMasterKey(raw: string | undefined): Buffer | null {
    if (!raw) return null;
    let key: Buffer;
    try {
        key = Buffer.from(raw, 'base64');
    } catch {
        return null;
    }
    return key.length === KEY_BYTES ? key : null;
}

/**
 * The available master keys, by version.
 *
 * `SECRETS_MASTER_KEY` is v1; the following ones are `SECRETS_MASTER_KEY_V2`,
 * `_V3`, … During a rotation they coexist: decryption uses the version written
 * on the row and encryption always uses the active one.
 */
function loadMasterKeys(): Map<number, Buffer> {
    const keys = new Map<number, Buffer>();
    const v1 = parseMasterKey(process.env.SECRETS_MASTER_KEY);
    if (v1) keys.set(1, v1);
    for (let version = 2; version <= 16; version += 1) {
        const key = parseMasterKey(process.env[`SECRETS_MASTER_KEY_V${version}`]);
        if (key) keys.set(version, key);
    }
    return keys;
}

function activeKeyVersion(keys: Map<number, Buffer>): number {
    const declared = Number.parseInt(process.env.SECRETS_ACTIVE_KEY_VERSION ?? '', 10);
    if (Number.isInteger(declared) && keys.has(declared)) return declared;
    return Math.max(...keys.keys());
}

/**
 * Per-tenant subkey, derived with HKDF using the scope as salt.
 *
 * A row copied from one tenant to another — by mistake, or maliciously by
 * someone with write access to the database — does not decrypt.
 */
function deriveKey(master: Buffer, scopeId: string): Buffer {
    return Buffer.from(
        crypto.hkdfSync('sha256', master, Buffer.from(scopeId, 'utf8'), HKDF_INFO, KEY_BYTES),
    );
}

/**
 * The authenticated data binds the ciphertext to its exact position.
 *
 * Without it, someone able to write to the database could move an `openai.apiKey`
 * row into `remoteWhisper.authToken` and have it exfiltrated by the connection
 * test endpoint, which sends that token to a host of their choosing.
 */
function buildAad(identity: SecretIdentity, keyVersion: number): Buffer {
    return Buffer.from(
        `${identity.scope}:${identity.scopeId}:${identity.secretKey}:${keyVersion}`,
        'utf8',
    );
}

function fingerprintOf(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 16);
}

function hintOf(plaintext: string): string {
    return plaintext.length <= 4 ? '••••' : plaintext.slice(-4);
}

export const secretVault = {
    /**
     * False when a valid master key is missing.
     *
     * The failure is "closed" and not fatal: the application starts, credential
     * writes answer 503 and any AI phase reports itself as not configured.
     * **Never auto-generate a key into a file**: a restart with an ephemeral
     * volume would make every secret undecryptable forever, without anyone
     * understanding why.
     */
    isEnabled(): boolean {
        return loadMasterKeys().size > 0;
    },

    activeKeyVersion(): number | null {
        const keys = loadMasterKeys();
        return keys.size === 0 ? null : activeKeyVersion(keys);
    },

    encrypt(identity: SecretIdentity, plaintext: string): EncryptedSecret {
        const keys = loadMasterKeys();
        if (keys.size === 0) {
            throw new SecretVaultError(
                'VAULT_UNAVAILABLE',
                'SECRETS_MASTER_KEY non configurata: impossibile salvare credenziali.',
            );
        }
        const keyVersion = activeKeyVersion(keys);
        const derived = deriveKey(keys.get(keyVersion)!, identity.scopeId);
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv(ALGORITHM, derived, iv);
        cipher.setAAD(buildAad(identity, keyVersion));
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

        return {
            ciphertext,
            iv,
            authTag: cipher.getAuthTag(),
            keyVersion,
            fingerprint: fingerprintOf(plaintext),
            hint: hintOf(plaintext),
        };
    },

    /**
     * Returns the secret, or `null` when it cannot be decrypted.
     *
     * An undecryptable row — a badly rotated, lost or replaced master key — is
     * never deleted: it is flagged and the user is asked to re-enter the
     * key. Destroying the data would make a configuration mistake irreversible
     * when it is in fact recoverable.
     */
    decrypt(identity: SecretIdentity, stored: Omit<EncryptedSecret, 'fingerprint' | 'hint'>): Secret | null {
        const keys = loadMasterKeys();
        const master = keys.get(stored.keyVersion);
        if (!master) return null;

        try {
            const derived = deriveKey(master, identity.scopeId);
            const decipher = crypto.createDecipheriv(ALGORITHM, derived, stored.iv);
            decipher.setAAD(buildAad(identity, stored.keyVersion));
            decipher.setAuthTag(stored.authTag);
            const plaintext = Buffer.concat([
                decipher.update(stored.ciphertext),
                decipher.final(),
            ]).toString('utf8');
            return new Secret(plaintext);
        } catch {
            // No detail in the log: the GCM error does not distinguish a wrong key
            // from tampered text, and there is nothing useful to print
            // that would not be a hint about the content.
            return null;
        }
    },

    fingerprintOf,
    hintOf,
};
