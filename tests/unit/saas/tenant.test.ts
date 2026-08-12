import { db } from '../../../src/db';
import { tenantRepository } from '../../../src/db/repositories/TenantRepository';

const TEST_GUILD = 'test_guild_saas_tenant';
const TEST_GUILD_2 = 'test_guild_saas_tenant_2';

function cleanup() {
    db.prepare('DELETE FROM tenants WHERE guild_id LIKE ?').run('test_guild_saas%');
    db.prepare('DELETE FROM usage_tracking WHERE guild_id LIKE ?').run('test_guild_saas%');
}

/**
 * `tenants` is the guild record, `usage_tracking` the usage telemetry.
 * There are no plans, quotas or limits any more: the software is free and every table
 * spends on its own provider account (BYOK). What remains here feeds
 * cost transparency, not billing.
 */
describe('TenantRepository', () => {
    beforeAll(cleanup);
    afterAll(cleanup);

    describe('Anagrafica gilda', () => {
        it('returns a virtual row for a guild that was never registered', () => {
            const tenant = tenantRepository.getOrDefaultTenant('unknown_guild_xyz');
            expect(tenant.guild_id).toBe('unknown_guild_xyz');
            expect(tenant.admin_discord_id).toBeNull();
            // Virtual: it must not materialize a row.
            expect(tenantRepository.getTenant('unknown_guild_xyz')).toBeUndefined();
        });

        it('creates and retrieves a guild', () => {
            tenantRepository.createTenant(TEST_GUILD, 'admin123');
            const tenant = tenantRepository.getTenant(TEST_GUILD);
            expect(tenant).toBeDefined();
            expect(tenant!.guild_id).toBe(TEST_GUILD);
            expect(tenant!.admin_discord_id).toBe('admin123');
        });

        it('upserts without dropping a known admin', () => {
            tenantRepository.upsertTenant(TEST_GUILD);
            expect(tenantRepository.getTenant(TEST_GUILD)!.admin_discord_id).toBe('admin123');

            tenantRepository.upsertTenant(TEST_GUILD, 'admin456');
            expect(tenantRepository.getTenant(TEST_GUILD)!.admin_discord_id).toBe('admin456');
        });

        it('lists registered guilds', () => {
            tenantRepository.upsertTenant(TEST_GUILD_2, 'admin789');
            const ids = tenantRepository.listTenants().map(t => t.guild_id);
            expect(ids).toContain(TEST_GUILD);
            expect(ids).toContain(TEST_GUILD_2);
        });
    });

    describe('Usage tracking', () => {
        it('auto-creates the usage row for the current month', () => {
            const usage = tenantRepository.getUsage(TEST_GUILD);
            expect(usage).toBeDefined();
            expect(usage.sessions_used).toBeGreaterThanOrEqual(0);
        });

        it('increments sessions', () => {
            const before = tenantRepository.getUsage(TEST_GUILD).sessions_used;
            tenantRepository.incrementSessions(TEST_GUILD);
            const after = tenantRepository.getUsage(TEST_GUILD).sessions_used;
            expect(after).toBe(before + 1);
        });

        it('adds audio minutes', () => {
            tenantRepository.addAudioMinutes(TEST_GUILD, 45.5);
            const usage = tenantRepository.getUsage(TEST_GUILD);
            expect(usage.audio_minutes_used).toBeGreaterThanOrEqual(45.5);
        });

        it('adds AI cost in both currencies', () => {
            tenantRepository.addAiCost(TEST_GUILD, 0.25, 0.225);
            const usage = tenantRepository.getUsage(TEST_GUILD);
            expect(usage.ai_cost_usd).toBeGreaterThanOrEqual(0.25);
            expect(usage.ai_cost_eur).toBeCloseTo(0.225);
        });

        it('keeps the EUR total NULL once an unconvertible cost lands in it', () => {
            // A cost with no reliable exchange rate must not become a fake zero:
            // the EUR total stays NULL and declares itself unreliable.
            tenantRepository.addAiCost(TEST_GUILD_2, 0.1, null);
            expect(tenantRepository.getUsage(TEST_GUILD_2).ai_cost_eur).toBeNull();

            tenantRepository.addAiCost(TEST_GUILD_2, 0.1, 0.09);
            expect(tenantRepository.getUsage(TEST_GUILD_2).ai_cost_eur).toBeNull();
            expect(tenantRepository.getUsage(TEST_GUILD_2).ai_cost_usd).toBeCloseTo(0.2);
        });

        it('sums lifetime usage across months', () => {
            const lifetime = tenantRepository.getLifetimeUsage(TEST_GUILD);
            expect(lifetime.sessions_used).toBeGreaterThanOrEqual(1);
            expect(lifetime.audio_minutes_used).toBeGreaterThanOrEqual(45.5);
        });
    });
});
