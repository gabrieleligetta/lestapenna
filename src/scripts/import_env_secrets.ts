/**
 * Moves into the vault the keys that today live in `.env`.
 *
 *   npm run secrets:import-env                     # list candidate guilds
 *   npm run secrets:import-env -- --guild 123      # import into that guild
 *   npm run secrets:import-env -- --guild 1,2,3    # into several guilds
 *   npm run secrets:import-env -- --guild 1 --dry-run
 *
 * Needed exactly once, at the move to BYOK, and it is **the last piece of code
 * that reads an AI key from the environment**. From here on only the vault
 * reads them.
 *
 * ⚠️ **Guilds must be named one by one, on purpose.** Before BYOK every table
 * on the instance spent the operator's key; importing it into all of them would
 * reproduce exactly that situation, while the point of this migration is to end
 * it. Whoever holds the key decides who keeps using it — usually their own
 * table and nobody else. Without `--guild` the script merely lists the
 * candidates.
 *
 * The same goes for the transcription PC token: that computer belongs to
 * someone, and its token is not a shared resource of the instance.
 *
 * It never overwrites an existing credential: anyone who has already configured
 * themselves takes precedence over an automatic migration.
 *
 * ⚠️ **Once the import succeeds, remove the keys from `.env`.** That is the
 * whole point of the operation: in the environment they stay in clear text,
 * they end up in the volume backups and in `docker inspect`; in the vault they
 * are encrypted at rest and bound to their own scope. The only secret that must
 * stay in the environment is `SECRETS_MASTER_KEY`, which the vault cannot keep
 * for itself.
 */

import { db } from '../db/client';
import { initDatabase } from '../db/schema';
import { config } from '../config';

const getEnv = (key: string): string | undefined => process.env[key]?.trim() || undefined;
import { tenantSecretsRepository } from '../db/repositories/TenantSecretsRepository';
import { secretVault } from '../services/secretVault';

interface EnvSecret { secretKey: string; value: string; label: string }

function envSecrets(): EnvSecret[] {
    const candidates: Array<{ secretKey: string; value: string | null | undefined; label: string }> = [
        { secretKey: 'openai.apiKey', value: config.ai.openAi.apiKey, label: 'OpenAI' },
        { secretKey: 'gemini.apiKey', value: config.ai.gemini.apiKey, label: 'Gemini' },
        { secretKey: 'anthropic.apiKey', value: config.ai.anthropic.apiKey, label: 'Anthropic' },
        { secretKey: 'ollamaCloud.apiKey', value: config.ai.ollamaCloud.apiKey, label: 'Ollama Cloud' },
        // The transcription PC token: that computer belongs to one specific
        // table, not to the instance. It only goes into explicitly named guilds.
        { secretKey: 'remoteWhisper.authToken', value: getEnv('REMOTE_WHISPER_AUTH_TOKEN'), label: 'PC di trascrizione (token)' },
    ];
    return candidates.filter((s): s is EnvSecret => typeof s.value === 'string' && s.value.trim().length > 0);
}

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Guilds with at least one campaign: the ones the bot actually serves. */
function activeGuilds(): Array<{ guildId: string; campaigns: number }> {
    const rows = db.prepare(`
        SELECT guild_id, COUNT(*) AS campaigns
        FROM campaigns WHERE guild_id IS NOT NULL
        GROUP BY guild_id ORDER BY campaigns DESC
    `).all() as Array<{ guild_id: string; campaigns: number }>;
    return rows.map(r => ({ guildId: r.guild_id, campaigns: r.campaigns }));
}

function main(): void {
    initDatabase();

    const dryRun = process.argv.includes('--dry-run');
    const only = arg('guild');

    if (!secretVault.isEnabled()) {
        console.error('Cassaforte non configurata: manca SECRETS_MASTER_KEY. Niente da fare.');
        process.exit(1);
    }

    const secrets = envSecrets();
    if (secrets.length === 0) {
        console.error('Nessuna chiave in ambiente da importare.');
        process.exit(1);
    }

    if (!only) {
        // No implicit target: importing into all of them would rebuild the very
        // situation this migration exists to end, namely a single key paying
        // for everyone.
        console.log('Gilde con almeno una campagna:\n');
        for (const guild of activeGuilds()) {
            console.log(`  ${guild.guildId}  (${guild.campaigns} campagne)`);
        }
        console.log(
            '\nScegli in quali importare le chiavi e rieseguilo con --guild <id>.\n' +
            'Le gilde che non nomini dovranno configurare le proprie: è il punto del BYOK.',
        );
        process.exit(0);
    }

    const targets = only.split(',').map(id => id.trim()).filter(Boolean);
    if (targets.length === 0) {
        console.error('--guild richiede almeno un id.');
        process.exit(1);
    }

    console.log(
        `${dryRun ? '[prova] ' : ''}Importo ${secrets.length} credenziali ` +
        `(${secrets.map(s => s.label).join(', ')}) in ${targets.length} gilde.\n`,
    );

    let written = 0;
    let kept = 0;

    for (const guildId of targets) {
        for (const secret of secrets) {
            const identity = { scope: 'guild' as const, scopeId: guildId, secretKey: secret.secretKey };
            if (tenantSecretsRepository.getMeta(identity)) {
                console.log(`  ${guildId}  ${secret.secretKey.padEnd(26)} già presente, lascio com'è`);
                kept++;
                continue;
            }
            if (!dryRun) {
                tenantSecretsRepository.put(identity, secret.value, 'import-env');
            }
            console.log(`  ${guildId}  ${secret.secretKey.padEnd(26)} ${dryRun ? 'da importare' : 'importata'}`);
            written++;
        }
    }

    console.log(`\n${dryRun ? 'Da scrivere' : 'Scritte'}: ${written} · già configurate: ${kept}`);
    if (dryRun) {
        console.log('Nessuna modifica: riesegui senza --dry-run per applicare.');
    } else {
        console.log(
            '\nFatto. Ora togli le chiavi AI da `.env`: nessuno le legge più, e ' +
            'lasciarcele significa tenerne una copia in chiaro nei backup del ' +
            'volume. Conserva solo SECRETS_MASTER_KEY.',
        );
    }
}

main();
