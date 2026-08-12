/**
 * The guard that stops the help from drifting again.
 *
 * The previous help was a hand-written list, so every command added after it was
 * written simply never appeared, and two commands it did name had been deleted
 * long before. Nothing failed, because nothing checked. This is the check: a
 * command without `category` and `descriptionKey` cannot be browsed, so it is a
 * test failure rather than a command nobody can find.
 *
 * It reads the sources rather than importing them. Importing registry.ts pulls
 * in the entire command tree — and with it BullMQ, Redis and the Discord voice
 * stack — which hangs the run; mocking all of that would be a large, brittle
 * fixture that tests the mocks more than the commands. What matters here is what
 * the files *declare*, and that is exactly what is read.
 */

import * as fs from 'fs';
import * as path from 'path';
import { en } from '../../../src/i18n/locales/en';
import { it as itLocale } from '../../../src/i18n/locales/it';
import { es } from '../../../src/i18n/locales/es';
import { fr } from '../../../src/i18n/locales/fr';
import { de } from '../../../src/i18n/locales/de';
import { ptBR } from '../../../src/i18n/locales/pt-BR';
import { CATEGORY_ORDER } from '../../../src/commands/types';

const COMMANDS_DIR = path.join(__dirname, '../../../src/commands');
const LOCALES: Record<string, Record<string, string>> = {
    en, it: itLocale, es, fr, de, 'pt-BR': ptBR,
};

interface Declared {
    export: string;
    file: string;
    name: string;
    aliases: string[];
    category?: string;
    descriptionKey?: string;
}

/**
 * The export names registry.ts actually registers.
 *
 * Two of them are imported renamed (`listCommand as listSessionsCommand`), so
 * the local identifier passed to register() is not the exported name: the
 * aliases are resolved back before matching.
 */
function registeredExports(): Set<string> {
    const src = fs.readFileSync(path.join(COMMANDS_DIR, 'registry.ts'), 'utf8');

    const localToExported = new Map<string, string>();
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
        for (const piece of m[1].split(',')) {
            const renamed = piece.trim().match(/^(\w+)\s+as\s+(\w+)$/);
            if (renamed) localToExported.set(renamed[2], renamed[1]);
        }
    }

    return new Set(
        [...src.matchAll(/dispatcher\.register\((\w+)\)/g)]
            .map(m => localToExported.get(m[1]) ?? m[1]),
    );
}

/** Every `export const xCommand: Command = { … }` under src/commands. */
function declaredCommands(): Declared[] {
    const out: Declared[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.ts')) continue;

            const src = fs.readFileSync(full, 'utf8');
            for (const m of src.matchAll(/export const (\w+Command)\s*:\s*Command\s*=\s*\{/g)) {
                const body = src.slice(m.index! + m[0].length, m.index! + m[0].length + 600);
                const name = body.match(/name:\s*'([^']+)'/);
                const aliases = body.match(/aliases:\s*\[([^\]]*)\]/);
                const category = body.match(/category:\s*'([^']+)'/);
                const descriptionKey = body.match(/descriptionKey:\s*'([^']+)'/);
                if (!name) continue;
                out.push({
                    export: m[1],
                    file: path.relative(COMMANDS_DIR, full),
                    name: name[1],
                    aliases: aliases
                        ? aliases[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean)
                        : [],
                    category: category?.[1],
                    descriptionKey: descriptionKey?.[1],
                });
            }
        }
    };
    walk(COMMANDS_DIR);
    return out;
}

const registered = registeredExports();
const all = declaredCommands();
const commands = all.filter(c => registered.has(c.export));

describe('command metadata', () => {
    it('finds a plausible number of registered commands', () => {
        // A floor: if the parsing above silently matched nothing, every other
        // assertion here would pass vacuously.
        expect(commands.length).toBeGreaterThan(40);
    });

    it('does not leave a command declared but never registered', () => {
        // mergeItemCommand and mergeQuestCommand lived like this for months:
        // written, exported, dead.
        const orphans = all.filter(c => !registered.has(c.export)).map(c => `${c.export} (${c.file})`);
        expect(orphans).toEqual([]);
    });

    it('does not expose an instance-wide wipe command through Discord', () => {
        const names = commands.flatMap(c => [c.name, ...c.aliases]);
        expect(names).not.toContain('wipe');
        expect(names).not.toContain('softwipe');
    });

    it.each(commands.map(c => [c.name, c] as const))('%s declares a valid category', (_n, cmd) => {
        expect(cmd.category).toBeDefined();
        expect(CATEGORY_ORDER).toContain(cmd.category as never);
    });

    it.each(commands.map(c => [c.name, c] as const))('%s declares a description key', (_n, cmd) => {
        expect(cmd.descriptionKey).toBeDefined();
        expect(Object.keys(en)).toContain(cmd.descriptionKey);
    });

    it('has a non-empty description in all six locales', () => {
        const missing: string[] = [];
        for (const cmd of commands) {
            for (const [locale, dict] of Object.entries(LOCALES)) {
                const text = dict[cmd.descriptionKey!];
                if (!text || !text.trim()) missing.push(`${cmd.name} / ${locale}`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('does not register the same name twice under different commands', () => {
        // Registration is last-one-wins, so a duplicate silently makes one
        // command unreachable — which is exactly how $autoupdate disappeared,
        // and how $resume came to mean something other than what it says.
        const seen = new Map<string, string>();
        const clashes: string[] = [];
        for (const cmd of commands) {
            for (const token of [cmd.name, ...cmd.aliases]) {
                const previous = seen.get(token);
                if (previous && previous !== cmd.name) {
                    clashes.push(`$${token}: ${previous} vs ${cmd.name}`);
                }
                seen.set(token, cmd.name);
            }
        }
        expect(clashes).toEqual([]);
    });
});
