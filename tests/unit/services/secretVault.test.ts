/**
 * The secret vault.
 *
 * What is kept here are API keys that cost money to the people who entrust them to us: the
 * security properties have to be demonstrated, not declared in the comments. In
 * particular that a row moved elsewhere does not open, that a wrong master key
 * destroys nothing, and that the plaintext cannot end up in a log
 * by oversight.
 */

import * as crypto from 'crypto';
import * as util from 'util';
import { Secret, secretVault, SecretVaultError } from '../../../src/services/secretVault';
import { tenantSecretsRepository } from '../../../src/db/repositories/TenantSecretsRepository';
import { tenantAiSettingsRepository } from '../../../src/db/repositories/TenantAiSettingsRepository';
import { db } from '../../../src/db';

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');

const IDENTITY = { scope: 'guild' as const, scopeId: 'guild-vault-1', secretKey: 'openai.apiKey' };
const API_KEY = ['sk', 'proj', 'example-only', '4f2a'].join('-');

function withKeys(fn: () => void, env: Record<string, string | undefined>): void {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        fn();
    } finally {
        process.env = saved;
    }
}

describe('secretVault', () => {
    beforeEach(() => {
        process.env.SECRETS_MASTER_KEY = KEY_A;
        delete process.env.SECRETS_MASTER_KEY_V2;
        delete process.env.SECRETS_ACTIVE_KEY_VERSION;
        db.prepare("DELETE FROM tenant_secrets WHERE scope_id LIKE 'guild-vault%'").run();
        db.prepare("DELETE FROM tenant_ai_settings WHERE scope_id LIKE 'guild-vault%'").run();
    });

    afterAll(() => {
        delete process.env.SECRETS_MASTER_KEY;
        db.prepare("DELETE FROM tenant_secrets WHERE scope_id LIKE 'guild-vault%'").run();
        db.prepare("DELETE FROM tenant_ai_settings WHERE scope_id LIKE 'guild-vault%'").run();
    });

    describe('cifratura', () => {
        it('round-trips the value', () => {
            const encrypted = secretVault.encrypt(IDENTITY, API_KEY);
            const decrypted = secretVault.decrypt(IDENTITY, encrypted);
            expect(decrypted?.reveal()).toBe(API_KEY);
        });

        it('never produces the same ciphertext twice for the same value', () => {
            // A random IV for every encryption: two identical rows must not
            // reveal that two tables use the same key.
            const a = secretVault.encrypt(IDENTITY, API_KEY);
            const b = secretVault.encrypt(IDENTITY, API_KEY);
            expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
            expect(a.iv.equals(b.iv)).toBe(false);
            // The fingerprint on the other hand is deterministic: it is there to detect changes.
            expect(a.fingerprint).toBe(b.fingerprint);
        });

        it('the ciphertext does not contain the plaintext value', () => {
            const encrypted = secretVault.encrypt(IDENTITY, API_KEY);
            expect(encrypted.ciphertext.toString('utf8')).not.toContain(API_KEY);
            expect(encrypted.ciphertext.toString('utf8')).not.toContain('sk-proj');
        });

        it('exposes only the last four digits as a hint', () => {
            expect(secretVault.encrypt(IDENTITY, API_KEY).hint).toBe('4f2a');
        });
    });

    describe('binding to the position (AAD and HKDF)', () => {
        it('does not decrypt if the row is moved to another tenant', () => {
            const encrypted = secretVault.encrypt(IDENTITY, API_KEY);
            const moved = secretVault.decrypt(
                { ...IDENTITY, scopeId: 'guild-vault-altro' }, encrypted,
            );
            expect(moved).toBeNull();
        });

        it('does not decrypt if the row is moved to another key', () => {
            // Without this constraint, someone able to write to the database could move
            // an OpenAI key into `remoteWhisper.authToken` and have it
            // sent to a host of their choosing by the test endpoint.
            const encrypted = secretVault.encrypt(IDENTITY, API_KEY);
            const moved = secretVault.decrypt(
                { ...IDENTITY, secretKey: 'remoteWhisper.authToken' }, encrypted,
            );
            expect(moved).toBeNull();
        });

        it('does not decrypt if the ciphertext is tampered with', () => {
            const encrypted = secretVault.encrypt(IDENTITY, API_KEY);
            encrypted.ciphertext[0] ^= 0xff;
            expect(secretVault.decrypt(IDENTITY, encrypted)).toBeNull();
        });
    });

    describe('master key', () => {
        it('is disabled when absent, without throwing on read', () => {
            withKeys(() => {
                expect(secretVault.isEnabled()).toBe(false);
                expect(secretVault.activeKeyVersion()).toBeNull();
            }, { SECRETS_MASTER_KEY: undefined });
        });

        it('refuses to save when absent, rather than writing plaintext', () => {
            withKeys(() => {
                expect(() => secretVault.encrypt(IDENTITY, API_KEY))
                    .toThrow(SecretVaultError);
            }, { SECRETS_MASTER_KEY: undefined });
        });

        it('ignores a key of the wrong length rather than using it', () => {
            withKeys(() => {
                expect(secretVault.isEnabled()).toBe(false);
            }, { SECRETS_MASTER_KEY: Buffer.from('troppo corta').toString('base64') });
        });

        it('a different master key does not open the value', () => {
            const encrypted = secretVault.encrypt(IDENTITY, API_KEY);
            withKeys(() => {
                expect(secretVault.decrypt(IDENTITY, encrypted)).toBeNull();
            }, { SECRETS_MASTER_KEY: KEY_B });
        });
    });

    describe('classe Secret', () => {
        it('never reveals the value through any form of printing', () => {
            const secret = new Secret(API_KEY);

            expect(String(secret)).toBe('Secret(***)');
            expect(`${secret}`).not.toContain(API_KEY);
            expect(JSON.stringify({ key: secret })).not.toContain(API_KEY);
            expect(util.inspect(secret)).not.toContain(API_KEY);
            expect(util.inspect({ nested: secret })).not.toContain(API_KEY);
            // The only route to the value is explicit and greppable.
            expect(secret.reveal()).toBe(API_KEY);
        });
    });
});

describe('tenantSecretsRepository', () => {
    beforeEach(() => {
        process.env.SECRETS_MASTER_KEY = KEY_A;
        delete process.env.SECRETS_MASTER_KEY_V2;
        delete process.env.SECRETS_ACTIVE_KEY_VERSION;
        db.prepare("DELETE FROM tenant_secrets WHERE scope_id LIKE 'guild-vault%'").run();
    });

    afterAll(() => {
        delete process.env.SECRETS_MASTER_KEY;
        db.prepare("DELETE FROM tenant_secrets WHERE scope_id LIKE 'guild-vault%'").run();
    });

    it('saves and reads back a credential', () => {
        tenantSecretsRepository.put(IDENTITY, API_KEY, 'user-1');
        expect(tenantSecretsRepository.getDecrypted(IDENTITY)?.reveal()).toBe(API_KEY);
    });

    it('does not store the plaintext value in the database', () => {
        tenantSecretsRepository.put(IDENTITY, API_KEY);
        const raw = db.prepare(
            'SELECT * FROM tenant_secrets WHERE scope_id = ?',
        ).get(IDENTITY.scopeId) as Record<string, unknown>;

        const dump = Object.values(raw)
            .map(v => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)))
            .join('|');
        expect(dump).not.toContain(API_KEY);
        expect(dump).not.toContain('sk-proj');
    });

    it('the metadata carries neither the value nor the ciphertext', () => {
        tenantSecretsRepository.put(IDENTITY, API_KEY, 'user-1');
        const meta = tenantSecretsRepository.getMeta(IDENTITY)!;

        expect(JSON.stringify(meta)).not.toContain(API_KEY);
        expect(meta).not.toHaveProperty('ciphertext');
        expect(meta.hint).toBe('4f2a');
        expect(meta.updatedBy).toBe('user-1');
    });

    it('replacing a credential clears the previous check result', () => {
        tenantSecretsRepository.put(IDENTITY, API_KEY);
        tenantSecretsRepository.markVerification(IDENTITY, 'OK');
        expect(tenantSecretsRepository.getMeta(IDENTITY)!.verifyStatus).toBe('OK');

        tenantSecretsRepository.put(IDENTITY, ['sk', 'proj', 'replacement-only', '9999'].join('-'));
        const meta = tenantSecretsRepository.getMeta(IDENTITY)!;
        // A new key is not verified merely because the previous one was.
        expect(meta.verifyStatus).toBeNull();
        expect(meta.lastVerifiedAt).toBeNull();
        expect(meta.hint).toBe('9999');
    });

    it('marks UNDECRYPTABLE without deleting, when the master key no longer opens it', () => {
        tenantSecretsRepository.put(IDENTITY, API_KEY);

        withKeys(() => {
            expect(tenantSecretsRepository.getDecrypted(IDENTITY)).toBeNull();
        }, { SECRETS_MASTER_KEY: KEY_B });

        const meta = tenantSecretsRepository.getMeta(IDENTITY);
        expect(meta).toBeDefined();
        expect(meta!.verifyStatus).toBe('UNDECRYPTABLE');
        // The right key reopens it: the data was not destroyed.
        expect(tenantSecretsRepository.getDecrypted(IDENTITY)?.reveal()).toBe(API_KEY);
    });

    it('rejects an empty credential', () => {
        expect(() => tenantSecretsRepository.put(IDENTITY, '   ')).toThrow();
    });

    describe('rotazione', () => {
        it('re-encrypts everything with the active key, values intact', () => {
            tenantSecretsRepository.put(IDENTITY, API_KEY);
            const second = { ...IDENTITY, secretKey: 'gemini.apiKey' };
            tenantSecretsRepository.put(second, 'gemini-key-1234');
            expect(tenantSecretsRepository.getMeta(IDENTITY)!.keyVersion).toBe(1);

            process.env.SECRETS_MASTER_KEY_V2 = KEY_B;
            process.env.SECRETS_ACTIVE_KEY_VERSION = '2';

            const result = tenantSecretsRepository.rotateAll();
            expect(result).toMatchObject({ rotated: 2, skipped: 0, alreadyCurrent: 0 });
            expect(tenantSecretsRepository.getMeta(IDENTITY)!.keyVersion).toBe(2);
            expect(tenantSecretsRepository.getDecrypted(IDENTITY)?.reveal()).toBe(API_KEY);
            expect(tenantSecretsRepository.getDecrypted(second)?.reveal()).toBe('gemini-key-1234');

            // Re-running it does no harm: the rows are already at the active version.
            expect(tenantSecretsRepository.rotateAll()).toMatchObject({ rotated: 0, alreadyCurrent: 2 });
        });

        it('skips and counts the rows it cannot open, without rewriting them', () => {
            tenantSecretsRepository.put(IDENTITY, API_KEY);
            const storedBefore = db.prepare(
                'SELECT ciphertext, key_version FROM tenant_secrets WHERE scope_id = ? AND secret_key = ?',
            ).get(IDENTITY.scopeId, IDENTITY.secretKey) as { ciphertext: Buffer; key_version: number };

            // A rotation towards v2, but the wrong key ended up in the v1
            // slot: the existing row can no longer be opened.
            process.env.SECRETS_MASTER_KEY = KEY_B;
            process.env.SECRETS_MASTER_KEY_V2 = KEY_B;
            process.env.SECRETS_ACTIVE_KEY_VERSION = '2';

            const result = tenantSecretsRepository.rotateAll();
            expect(result).toMatchObject({ rotated: 0, skipped: 1, alreadyCurrent: 0 });

            // The row stayed exactly as it was: no blind rewrite.
            const storedAfter = db.prepare(
                'SELECT ciphertext, key_version FROM tenant_secrets WHERE scope_id = ? AND secret_key = ?',
            ).get(IDENTITY.scopeId, IDENTITY.secretKey) as { ciphertext: Buffer; key_version: number };
            expect(storedAfter.key_version).toBe(storedBefore.key_version);
            expect(storedAfter.ciphertext.equals(storedBefore.ciphertext)).toBe(true);

            // Putting the right key back, the value is still there, intact.
            process.env.SECRETS_MASTER_KEY = KEY_A;
            expect(tenantSecretsRepository.getDecrypted(IDENTITY)?.reveal()).toBe(API_KEY);
        });
    });
});

describe('tenantAiSettingsRepository', () => {
    const SCOPE_ID = 'guild-vault-settings';

    afterAll(() => {
        db.prepare("DELETE FROM tenant_ai_settings WHERE scope_id LIKE 'guild-vault%'").run();
    });

    it('saves and reads back the settings', () => {
        tenantAiSettingsRepository.put('guild', SCOPE_ID, { tiers: { quality: { provider: 'openai' } } }, 'user-1');
        const record = tenantAiSettingsRepository.get<{ tiers: { quality: { provider: string } } }>('guild', SCOPE_ID);

        expect(record?.settings.tiers.quality.provider).toBe('openai');
        expect(record?.updatedBy).toBe('user-1');
        expect(record?.schemaVersion).toBe(1);
    });

    it('overwrites without duplicating the row', () => {
        tenantAiSettingsRepository.put('guild', SCOPE_ID, { a: 1 });
        tenantAiSettingsRepository.put('guild', SCOPE_ID, { a: 2 });

        const rows = db.prepare(
            'SELECT count(*) AS c FROM tenant_ai_settings WHERE scope = ? AND scope_id = ?',
        ).get('guild', SCOPE_ID) as { c: number };
        expect(rows.c).toBe(1);
        expect(tenantAiSettingsRepository.get<{ a: number }>('guild', SCOPE_ID)?.settings.a).toBe(2);
    });

    it('falls back to the defaults when the stored JSON is unreadable', () => {
        // Better the file defaults than an AI resolution that blows up: the
        // result is the same as a tenant that has not configured anything yet.
        tenantAiSettingsRepository.put('guild', SCOPE_ID, { a: 1 });
        db.prepare('UPDATE tenant_ai_settings SET settings_json = ? WHERE scope_id = ?')
            .run('{ non json', SCOPE_ID);

        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(tenantAiSettingsRepository.get('guild', SCOPE_ID)).toBeUndefined();
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});
