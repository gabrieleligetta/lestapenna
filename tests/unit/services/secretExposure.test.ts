/**
 * Containment of the credentials' plaintext.
 *
 * The `Secret` class stops a key from ending up in a log by
 * oversight, but `reveal()` reopens it: the protection is worth as much as the
 * discipline about *where* it is called. A comment is not enough to guarantee that — a
 * test is.
 *
 * If this test fails, someone has added a point where a credential
 * becomes a bare string again. It should be assessed case by case, not added
 * to the list to get the build green.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', '..', 'src');

/** Where the plaintext is unavoidable: building the SDK client and re-encrypting. */
const ALLOWED = new Set([
    'bard/ai/providerFactory.ts',      // registry dei client + impronta per il pool
    'bard/geminiNativeGenerate.ts',    // SDK nativo Gemini
    'bard/geminiNativeTranscribe.ts',  // SDK nativo Gemini, trascrizione
    'bard/anthropicNativeGenerate.ts', // SDK nativo Anthropic
    'bard/agent/geminiNative.ts',      // SDK nativo Gemini, percorso agentico
    'bard/agent/anthropicNative.ts',   // SDK nativo Anthropic, percorso agentico
    'services/secretVault.ts',         // definizione di Secret
    'db/repositories/TenantSecretsRepository.ts', // rotazione: decifra e ricifra
    // The tokens for the table's PC have to be sent to that server, so sooner or later
    // they become strings again. They leave here already as ready-made headers, so the worker and
    // the shutdown never touch the plaintext: one place instead of three.
    'bard/ai/transcription.ts',
]);

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (entry.name.endsWith('.ts')) acc.push(full);
    }
    return acc;
}

describe('confining the credential plaintext', () => {
    const files = walk(SRC);

    it('reveal() is called only from the authorised files', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const relative = path.relative(SRC, file).split(path.sep).join('/');
            if (ALLOWED.has(relative)) continue;
            // Occurrences inside a comment open nothing.
            const code = fs.readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/.*$/gm, '');
            if (code.includes('.reveal()')) offenders.push(relative);
        }
        expect(offenders).toEqual([]);
    });

    it('no API module can reach a credential\'s plaintext', () => {
        // The HTTP layer must only see the metadata: `getDecrypted` from a
        // controller would mean an endpoint can return a key.
        const offenders = files
            .filter(f => path.relative(SRC, f).startsWith(`api${path.sep}`))
            .filter(f => fs.readFileSync(f, 'utf8').includes('getDecrypted'))
            .map(f => path.relative(SRC, f));
        expect(offenders).toEqual([]);
    });
});
