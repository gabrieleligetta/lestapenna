import { db } from '../client';
import type { SecretScope } from '../../services/secretVault';

/**
 * Non-secret AI settings, per tenant.
 *
 * JSON rather than columns: the shape mirrors `AiJsonConfig`, which already has
 * a deep-merge, and it is never queried by field — the whole object is read
 * every time a phase is resolved.
 *
 * Credentials live elsewhere (`TenantSecretsRepository`): nothing that needs
 * encrypting may end up here.
 */

export const TENANT_AI_SETTINGS_SCHEMA_VERSION = 1;

export interface TenantAiSettingsRecord<T = Record<string, unknown>> {
    scope: SecretScope;
    scopeId: string;
    schemaVersion: number;
    settings: T;
    updatedAt: number;
    updatedBy: string | null;
}

interface SettingsRow {
    scope: SecretScope;
    scope_id: string;
    schema_version: number;
    settings_json: string;
    updated_at: number;
    updated_by: string | null;
}

function toRecord<T>(row: SettingsRow): TenantAiSettingsRecord<T> | undefined {
    let settings: T;
    try {
        settings = JSON.parse(row.settings_json) as T;
    } catch (error) {
        // Corrupt JSON must not bring AI resolution down: it degrades to the
        // file defaults, which is the same behaviour as a tenant with no saved
        // settings.
        console.error(
            `[TenantAiSettings] JSON illeggibile per ${row.scope}:${row.scope_id}, uso i default.`,
            error,
        );
        return undefined;
    }
    return {
        scope: row.scope,
        scopeId: row.scope_id,
        schemaVersion: row.schema_version,
        settings,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
    };
}

export const tenantAiSettingsRepository = {
    get<T = Record<string, unknown>>(
        scope: SecretScope,
        scopeId: string,
    ): TenantAiSettingsRecord<T> | undefined {
        const row = db.prepare(
            'SELECT * FROM tenant_ai_settings WHERE scope = ? AND scope_id = ?',
        ).get(scope, scopeId) as SettingsRow | undefined;
        return row ? toRecord<T>(row) : undefined;
    },

    put(
        scope: SecretScope,
        scopeId: string,
        settings: unknown,
        updatedBy: string | null = null,
    ): void {
        db.prepare(`
            INSERT INTO tenant_ai_settings (
                scope, scope_id, schema_version, settings_json, updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, scope_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                settings_json = excluded.settings_json,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by
        `).run(
            scope, scopeId, TENANT_AI_SETTINGS_SCHEMA_VERSION,
            JSON.stringify(settings), Date.now(), updatedBy,
        );
    },

    remove(scope: SecretScope, scopeId: string): boolean {
        return db.prepare(
            'DELETE FROM tenant_ai_settings WHERE scope = ? AND scope_id = ?',
        ).run(scope, scopeId).changes > 0;
    },
};
