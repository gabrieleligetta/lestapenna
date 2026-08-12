/**
 * Regenerates COMMANDS.md from the command metadata.
 *
 * That file is published, and it had drifted badly: it documented `$nota`,
 * `$miaclasse`, `$miarazza`, `$miadesc`, `$impostasessione` and `$resetpg`, none
 * of which are registered, while missing several that are. A list maintained by
 * hand next to a list maintained by code will always end up saying two different
 * things — so this one is derived.
 *
 *   npm run docs:commands
 *
 * Like tests/unit/commands/helpCoverage.test.ts, it reads the sources instead of
 * importing them: importing the registry drags in BullMQ, Redis and the voice
 * stack, none of which a documentation generator should need to boot.
 */

import * as fs from 'fs';
import * as path from 'path';
import { en } from '../i18n/locales/en';
import { CATEGORY_ORDER, CommandCategory } from '../commands/types';

const ROOT = path.join(__dirname, '..', '..');
const COMMANDS_DIR = path.join(ROOT, 'src', 'commands');
const OUTPUT = path.join(ROOT, 'COMMANDS.md');

interface Declared {
    exportName: string;
    name: string;
    aliases: string[];
    category?: CommandCategory;
    descriptionKey?: string;
    adminOnly: boolean;
    operatorOnly: boolean;
}

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
                if (!name) continue;
                const aliases = body.match(/aliases:\s*\[([^\]]*)\]/);
                out.push({
                    exportName: m[1],
                    name: name[1],
                    aliases: aliases
                        ? aliases[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean)
                        : [],
                    category: body.match(/category:\s*'([^']+)'/)?.[1] as CommandCategory | undefined,
                    descriptionKey: body.match(/descriptionKey:\s*'([^']+)'/)?.[1],
                    adminOnly: /adminOnly:\s*true/.test(body),
                    operatorOnly: /operatorOnly:\s*true/.test(body),
                });
            }
        }
    };
    walk(COMMANDS_DIR);
    return out;
}

const CATEGORY_TITLES: Record<CommandCategory, string> = {
    sessione: '🎙️ Sessions',
    personaggi: '👤 Characters',
    entita: '🧩 World records',
    mondo: '🌍 Place and time',
    narrativa: '📖 Story',
    campagna: '🗺️ Campaigns',
    admin: '⚙️ Settings',
    meta: '💛 About Lestapenna',
    dev: '⚠️ Danger zone',
};

function permission(cmd: Declared): string {
    if (cmd.operatorOnly) return 'Administrator';
    if (cmd.adminOnly) return 'Manage Server';
    return 'Anyone';
}

function main(): void {
    const registered = registeredExports();
    const commands = declaredCommands()
        .filter(c => registered.has(c.exportName))
        .sort((a, b) => a.name.localeCompare(b.name));

    const dict = en as Record<string, string>;
    const lines: string[] = [
        '# Lestapenna — command reference',
        '',
        '> Generated from the command metadata by `npm run docs:commands`.',
        '> Do not edit by hand: the previous version of this file was written by',
        '> hand and ended up documenting commands that no longer existed.',
        '',
        `All commands use the \`$\` prefix. ${commands.length} commands, `
        + `in ${CATEGORY_ORDER.length} groups.`,
        '',
    ];

    for (const category of CATEGORY_ORDER) {
        const inCategory = commands.filter(c => c.category === category);
        if (!inCategory.length) continue;

        lines.push(`## ${CATEGORY_TITLES[category]}`, '');
        if (category === 'dev') {
            lines.push('> These are destructive or maintenance commands. They ask for',
                '> confirmation, but they cannot be undone.', '');
        }
        lines.push('| Command | Also | Who | What it does |', '| :--- | :--- | :--- | :--- |');
        for (const cmd of inCategory) {
            const aliases = cmd.aliases.length ? cmd.aliases.map(a => `\`$${a}\``).join(', ') : '—';
            const description = cmd.descriptionKey ? dict[cmd.descriptionKey] ?? '' : '';
            lines.push(`| \`$${cmd.name}\` | ${aliases} | ${permission(cmd)} | ${description} |`);
        }
        lines.push('');
    }

    lines.push('---', '',
        'Type `$help` in Discord for the same list, browsable and in your',
        'server’s language, or `$help <command>` for one command in detail.', '');

    fs.writeFileSync(OUTPUT, lines.join('\n'), 'utf8');
    console.log(`COMMANDS.md rigenerato: ${commands.length} comandi.`);
}

main();
