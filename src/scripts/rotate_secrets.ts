/**
 * Rotation of the secret vault's master key.
 *
 *   1. generate the new key:     npm run secrets:generate-key
 *   2. add it to the environment: SECRETS_MASTER_KEY_V2=<new>
 *      leaving in place:          SECRETS_MASTER_KEY=<old>
 *   3. run:                       npm run secrets:rotate
 *   4. only once rotation is complete, remove the old key from the environment.
 *
 * As long as the old key stays in the environment the rotation is reversible.
 * Rows the active key cannot open are skipped and counted, never blindly
 * rewritten: a partial rotation can be recovered from, a destructive one cannot.
 */

import { tenantSecretsRepository } from '../db/repositories/TenantSecretsRepository';
import { secretVault } from '../services/secretVault';
import { initDatabase } from '../db/schema';

function main(): void {
    initDatabase();

    const version = secretVault.activeKeyVersion();
    if (version === null) {
        console.error('Nessuna master key configurata: imposta SECRETS_MASTER_KEY.');
        process.exit(1);
    }

    console.log(`Ricifro tutte le credenziali con la master key v${version}...`);
    const { rotated, skipped, alreadyCurrent } = tenantSecretsRepository.rotateAll();

    console.log(`  ricifrate:        ${rotated}`);
    console.log(`  già aggiornate:   ${alreadyCurrent}`);
    console.log(`  non decifrabili:  ${skipped}`);

    if (skipped > 0) {
        console.error(
            '\n⚠️ Alcune credenziali non sono state ricifrate: la chiave che le apre non è\n' +
            '   in ambiente. NON rimuovere la vecchia SECRETS_MASTER_KEY — rimettila e\n' +
            '   riesegui, oppure fai reinserire quelle credenziali dai rispettivi tavoli.',
        );
        process.exit(2);
    }
    console.log('\nRotazione completata: ora puoi rimuovere la vecchia chiave dall\'ambiente.');
}

main();
