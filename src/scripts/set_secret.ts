/**
 * Writes a credential into a table's vault, from the command line.
 *
 *   npm run secrets:set -- --guild <guildId> --key openai.apiKey
 *
 * It exists because no guild reads keys from `.env` any more: the normal route
 * is the web app's settings page, but an instance running only the Discord bot
 * must still be able to configure its own keys.
 *
 * The value is **not passed as an argument**: it is typed when prompted.
 * Arguments end up in the shell history and in the process list, where an API
 * key must never appear.
 */

import * as readline from 'readline';
import { initDatabase } from '../db/schema';
import { tenantSecretsRepository } from '../db/repositories/TenantSecretsRepository';
import { secretVault } from '../services/secretVault';
import { SECRET_KEY_BY_PROVIDER } from '../bard/ai/credentials';
import { wakeSecretKey } from '../bard/ai/transcription';
import { listWakeMethods } from '../services/wake';

/**
 * The keys the system knows how to use, so a misspelled one is never stored.
 *
 * The wake-method secrets are asked of the registry instead of being listed:
 * written by hand they fell behind — `wol.iliadboxPassword` was still here
 * after the resolver had started looking for `wake.iliadbox.password`, and
 * anyone who had used it would have stored a password nobody reads, without an
 * error anywhere.
 */
const KNOWN_KEYS = [
    ...Object.values(SECRET_KEY_BY_PROVIDER).filter((k): k is string => k !== null),
    'remoteWhisper.authToken',
    'remoteWhisper.shutdownToken',
    ...listWakeMethods().flatMap(method =>
        method.fields.filter(f => f.secret).map(f => wakeSecretKey(method.id, f.name))),
];

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Reads a line without echoing it to the screen, the way a password would. */
function promptHidden(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
    let asked = false;
    output._writeToOutput = (text: string) => {
        if (!asked) { output.output.write(text); asked = true; }
    };
    return new Promise(resolve => rl.question(question, answer => {
        output.output.write('\n');
        rl.close();
        resolve(answer);
    }));
}

async function main(): Promise<void> {
    initDatabase();

    const guildId = arg('guild');
    const secretKey = arg('key');

    if (!guildId || !secretKey) {
        console.error('Uso: npm run secrets:set -- --guild <guildId> --key <nome>');
        console.error(`Chiavi note: ${KNOWN_KEYS.join(', ')}`);
        process.exit(1);
    }

    if (!KNOWN_KEYS.includes(secretKey)) {
        console.error(`"${secretKey}" non è una chiave riconosciuta. Attese: ${KNOWN_KEYS.join(', ')}`);
        process.exit(1);
    }

    if (!secretVault.isEnabled()) {
        console.error(
            'Cassaforte non configurata: manca SECRETS_MASTER_KEY.\n' +
            'Generane una con `npm run secrets:generate-key` e mettila in ambiente.',
        );
        process.exit(1);
    }

    const value = await promptHidden(`Valore per ${secretKey} (gilda ${guildId}): `);
    if (!value.trim()) {
        console.error('Valore vuoto: non salvo nulla.');
        process.exit(1);
    }

    tenantSecretsRepository.put(
        { scope: 'guild', scopeId: guildId, secretKey },
        value,
        'cli',
    );

    const meta = tenantSecretsRepository.getMeta({ scope: 'guild', scopeId: guildId, secretKey });
    console.log(`✅ Salvata: ${secretKey} → ${meta?.hint ?? '****'} (gilda ${guildId})`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
